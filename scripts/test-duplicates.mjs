// Checks the duplicate finder's pieces offline: node --test scripts/test-duplicates.mjs
// Songs are made up by ffmpeg (bundled as ffmpeg-static), so nothing is downloaded.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { compare, decodeAudio, libraryPrint, prepareQuery, queryPrint } from "../server/duplicates/fingerprint.mjs";
import { linkKey, namesOverlap, sourceKeys } from "../server/duplicates/keys.mjs";
import { PAYLOAD_PREFIX_BYTES, payloadHashOfBuffer, payloadHashOfFile } from "../server/duplicates/payload.mjs";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");
let dir;
const file = (name) => path.join(dir, name);
function run(...args) {
  const done = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { windowsHide: true });
  if (done.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${done.stderr}`);
}

/**
 * A made-up song, 70 s: a melody that changes note every quarter second over a
 * bass line and noisy drums, from `seed`, so each seed is its own "song".
 */
function song(name, seed) {
  const r = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const notes = Array.from({ length: 16 }, (_, i) => Math.round(220 * 2 ** (Math.floor(r(i) * 24) / 12)));
  const bass = Array.from({ length: 4 }, (_, i) => Math.round(55 * 2 ** (Math.floor(r(i + 40) * 12) / 12)));
  const pick = (list, rate) => list.reduceRight((rest, f, i) => `if(eq(mod(floor(t*${rate}),${list.length}),${i}),${f},${rest})`, list[0]);
  const melody = `0.25*sin(2*PI*${pick(notes, 4)}*t)*(1-mod(t*4,1))`;
  const low = `0.3*sin(2*PI*${pick(bass, 0.5)}*t)`;
  const drums = `0.2*(random(${seed})*2-1)*exp(-12*mod(t*${1 + Math.floor(r(99) * 3)},1))`;
  // Quoted, so the expression's commas don't split the filter graph.
  run("-f", "lavfi", "-i", `aevalsrc='${melody}+${low}+${drums}':s=44100:d=70`, "-c:a", "pcm_s16le", file(`${name}.wav`));
}

async function print(name, { seconds, fine }) {
  const samples = await decodeAudio(ffmpeg, file(name), { seconds });
  assert.ok(samples, `${name} decodes`);
  return fine ? queryPrint(samples) : libraryPrint(samples);
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopify-duplicates-test-"));
  song("a", 1);
  song("b", 2);
  song("c", 3);
  // The same song: AAC as YouTube sends it (fragmented MP4) and as Slopify saves it (plain, tagged).
  run("-i", file("a.wav"), "-c:a", "aac", "-b:a", "128k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000", file("a-fragmented.m4a"));
  run("-i", file("a-fragmented.m4a"), "-c:a", "copy", "-movflags", "+faststart", "-metadata", "title=Tagged", file("a-plain.m4a"));
  // As SoundCloud sends it, with and without an ID3 tag.
  run("-i", file("a.wav"), "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "0", "-write_xing", "0", file("a.mp3"));
  run("-i", file("a.mp3"), "-c:a", "copy", "-id3v2_version", "3", "-metadata", "title=Tagged", file("a-tagged.mp3"));
  // Elsewhere: another encode at another quality and volume, and one with a 9-second intro.
  run("-i", file("a.wav"), "-af", "volume=0.6", "-c:a", "libmp3lame", "-b:a", "96k", file("a-other.mp3"));
  run("-f", "lavfi", "-i", "anoisesrc=d=9:a=0.05:seed=7", "-i", file("a.wav"), "-filter_complex", "[0:a]aresample=44100,aformat=channel_layouts=mono[n];[1:a]aformat=channel_layouts=mono[s];[n][s]concat=n=2:v=0:a=1", "-c:a", "aac", "-b:a", "128k", file("a-intro.m4a"));
  // A loop: one half-second pattern over and over, whose fingerprint repeats itself throughout.
  run("-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*if(lt(mod(t,0.5),0.25),440,660)*t)*(1-mod(t*4,1))+0.1*sin(2*PI*110*t)':s=44100:d=60", "-c:a", "pcm_s16le", file("loop.wav"));
  run("-i", file("loop.wav"), "-c:a", "libmp3lame", "-b:a", "128k", file("loop.mp3"));
  // Silence, which must never count as a match.
  run("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "60", "-c:a", "aac", file("silence.m4a"));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the audio-data hash ignores the file around the sound", async () => {
  const fragmented = await payloadHashOfFile(file("a-fragmented.m4a"));
  assert.ok(fragmented);
  assert.equal(await payloadHashOfFile(file("a-plain.m4a")), fragmented);
  // From the stream's first bytes only, as the check reads it.
  const start = fs.readFileSync(file("a-fragmented.m4a")).subarray(0, PAYLOAD_PREFIX_BYTES);
  assert.equal(await payloadHashOfBuffer(start), fragmented);
  const mp3 = await payloadHashOfFile(file("a.mp3"));
  assert.ok(mp3);
  assert.equal(await payloadHashOfFile(file("a-tagged.mp3")), mp3);
  assert.notEqual(await payloadHashOfFile(file("a-other.mp3")), mp3);
  assert.equal(await payloadHashOfFile(file("silence.m4a")), null);
});

test("a fingerprint knows the same song from elsewhere, and only that", async () => {
  const library = { a: await print("a-plain.m4a", { seconds: 900 }), b: await print("b.wav", {}), c: await print("c.wav", {}) };
  const results = {};
  for (const [name, expected] of [["a-other.mp3", "a"], ["a-intro.m4a", "a"], ["a.mp3", "a"], ["b.wav", "b"], ["silence.m4a", null]]) {
    const samples = await decodeAudio(ffmpeg, file(name), { seconds: 45 });
    if (!samples) {
      assert.equal(expected, null, `${name} decodes`);
      continue;
    }
    const query = prepareQuery(queryPrint(samples));
    for (const [key, stored] of Object.entries(library)) {
      const match = compare(query, stored);
      results[`${name} vs ${key}`] = match ? `${match.same ? "SAME" : "different"} ber=${match.ber.toFixed(3)} best=${match.bestWindowBer.toFixed(3)} overlap=${match.overlapSeconds.toFixed(0)}s offset=${match.offsetSeconds.toFixed(2)}s` : "no alignment";
      assert.equal(Boolean(match?.same), key === expected, `${name} vs ${key}: ${results[`${name} vs ${key}`]}`);
    }
  }
  console.log(results);
});

test("a repetitive recording still finds itself", async () => {
  const stored = await print("loop.wav", {});
  const samples = await decodeAudio(ffmpeg, file("loop.mp3"), { seconds: 45 });
  const match = compare(prepareQuery(queryPrint(samples)), stored);
  assert.ok(match?.same, `loop vs itself: ${JSON.stringify(match)}`);
  const other = compare(prepareQuery(queryPrint(samples)), await print("a-plain.m4a", {}));
  assert.ok(!other?.same, `loop vs a: ${JSON.stringify(other)}`);
});

test("source keys write each upload one way", () => {
  assert.equal(linkKey("https://youtu.be/dQw4w9WgXcQ?t=3"), "youtube:dQw4w9WgXcQ");
  assert.equal(linkKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1"), "youtube:dQw4w9WgXcQ");
  assert.equal(linkKey("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube:dQw4w9WgXcQ");
  assert.equal(linkKey("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x"), "spotify:4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(linkKey("https://soundcloud.com/Artist/Track-Name?in=x"), "soundcloud:artist/track-name");
  assert.equal(linkKey("https://soundcloud.com/artist/sets/mix"), null);
  const saved = { sourceURL: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", sourceIdentity: { provider: "spotify", providerID: "4cOdK2wGLETKBW3PvgPWqT", aliases: [{ provider: "youtube", providerID: "dQw4w9WgXcQ", sourcePageURL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] } };
  assert.ok(sourceKeys(saved).has("youtube:dQw4w9WgXcQ"));
  assert.ok(sourceKeys({ sourceIdentity: { provider: "soundcloud", providerID: "soundcloud:123" } }).has("soundcloud-id:123"));
});

test("names that might be one song", () => {
  assert.ok(namesOverlap({ title: "Artist - Song Name (Official Video)", artist: "ArtistVEVO" }, { title: "Song Name", artist: "Artist" }));
  assert.ok(namesOverlap({ title: "Song Name", artist: "Artist" }, { title: "Song Name [Lyrics]", artist: "Lyric Channel" }));
  assert.ok(!namesOverlap({ title: "Another Tune", artist: "Artist" }, { title: "Song Name", artist: "Artist" }));
});
