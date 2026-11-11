// Counts the requests Slopify sends YouTube, against a made-up YouTube (nothing goes online):
// node --test scripts/test-youtube-requests.mjs
// YOUTUBE_PROVIDER=<path> runs it against another copy of the provider (say, an older one), to compare counts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const provider = process.env.YOUTUBE_PROVIDER ? path.resolve(process.env.YOUTUBE_PROVIDER) : "../server/providers/local-youtube.cjs";
const { isLastingRefusal, resolveYouTubeAudio, resolveYouTubeVideo, youtubeCoolingDown } = createRequire(import.meta.url)(provider);

/**
 * A made-up YouTube that answers like the real one and logs each request: "page", "player" or "stream".
 * `refuse`: videos it asks to confirm this isn't a bot. `forbid(url)`: streams it turns away (403);
 * each player answer's stream addresses carry `gen`, its number, so an old answer's can be told apart.
 */
function fakeYouTube({ refuse = [], forbid = () => false } = {}) {
  const log = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith(".googlevideo.com")) {
      log.push("stream");
      if (forbid(url)) return new Response(null, { status: 403 });
      const total = Number(url.searchParams.get("clen"));
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${total}`, "content-length": "1", "content-type": url.searchParams.get("mime") },
      });
    }
    if (url.pathname === "/youtubei/v1/player") {
      log.push("player");
      const { videoId } = JSON.parse(options.body);
      if (refuse.includes(videoId)) {
        return Response.json({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" } });
      }
      const format = (itag, mime, size, extra = {}) => ({
        itag,
        mimeType: `${mime}; codecs="x"`,
        contentLength: String(size),
        bitrate: 1000,
        url: `https://rr1---sn-test.googlevideo.com/videoplayback?id=${videoId}&itag=${itag}&gen=${log.filter((entry) => entry === "player").length}&mime=${encodeURIComponent(mime)}&clen=${size}`,
        ...extra,
      });
      return Response.json({
        playabilityStatus: { status: "OK" },
        videoDetails: { videoId, title: "A song", author: "An artist", lengthSeconds: "200" },
        streamingData: {
          adaptiveFormats: [format(140, "audio/mp4", 3000), format(137, "video/mp4", 9000, { qualityLabel: "1080p", height: 1080, width: 1920 })],
        },
      });
    }
    log.push("page");
    return new Response(`<script>ytcfg.set({"VISITOR_DATA":"visitor-${log.length}"})</script>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  const count = (kind) => log.filter((entry) => entry === kind).length;
  return { fetchImpl, count, counts: () => ({ page: count("page"), player: count("player"), stream: count("stream") }) };
}

const SONG = "aaaaaaaaaaa";
const OTHER = "bbbbbbbbbbb";
const REFUSED = "ccccccccccc";

test("a song's audio: one watch page, one player answer, one stream check", async (t) => {
  const yt = fakeYouTube();
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
  t.diagnostic(JSON.stringify(yt.counts()));
  assert.deepEqual(yt.counts(), { page: 1, player: 1, stream: 1 });
});

test("a streamed video's audio and video, fetched together, share the watch page, the player answer and the audio check", async (t) => {
  const yt = fakeYouTube();
  await Promise.all([resolveYouTubeAudio(SONG, undefined, yt.fetchImpl), resolveYouTubeVideo(SONG, undefined, yt.fetchImpl)]);
  t.diagnostic(JSON.stringify(yt.counts()));
  // Checks: the video stream, and the audio stream once (both lookups use it).
  assert.deepEqual(yt.counts(), { page: 1, player: 1, stream: 2 });
});

test("a kept player answer whose stream is turned away is asked for again once, and the song isn't refused", async (t) => {
  // The first answer's video stream has expired by the time it's checked.
  const yt = fakeYouTube({ forbid: (url) => url.searchParams.get("gen") === "1" && url.searchParams.get("itag") === "137" });
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
  const video = await resolveYouTubeVideo(SONG, undefined, yt.fetchImpl);
  assert.equal(video.videoID, SONG);
  t.diagnostic(JSON.stringify(yt.counts()));
  assert.equal(yt.count("player"), 2);
  assert.equal(yt.count("page"), 1);
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
});

test("a video stream turned away doesn't refuse the song's audio", async () => {
  const yt = fakeYouTube({ forbid: (url) => url.searchParams.get("itag") === "137" });
  const error = await resolveYouTubeVideo(SONG, undefined, yt.fetchImpl).catch((failure) => failure);
  assert.equal(error.code, "YOUTUBE_STREAM_FORBIDDEN");
  assert.equal(isLastingRefusal?.(error), false);
  assert.equal(youtubeCoolingDown?.(yt.fetchImpl), false);
  const audio = await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
  assert.equal(audio.videoID, SONG);
});

test("the next song reuses the session instead of fetching another watch page", async (t) => {
  const yt = fakeYouTube();
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
  await resolveYouTubeAudio(OTHER, undefined, yt.fetchImpl);
  t.diagnostic(JSON.stringify(yt.counts()));
  assert.equal(yt.count("page"), 1);
  assert.equal(yt.count("player"), 2);
});

test("a refused video is asked about once, not at the other address or as the other app, and not again", async (t) => {
  const yt = fakeYouTube({ refuse: [REFUSED] });
  const first = await resolveYouTubeAudio(REFUSED, undefined, yt.fetchImpl).catch((error) => error);
  assert.equal(first.code, "YOUTUBE_PLAYBACK_VERIFICATION_REQUIRED");
  const again = await resolveYouTubeAudio(REFUSED, undefined, yt.fetchImpl).catch((error) => error);
  assert.equal(again.code, "YOUTUBE_PLAYBACK_VERIFICATION_REQUIRED");
  t.diagnostic(JSON.stringify(yt.counts()));
  assert.deepEqual(yt.counts(), { page: 1, player: 1, stream: 0 });
  assert.equal(isLastingRefusal?.(first), true);
  // Right after a refusal, fetches nobody is waiting for hold off.
  assert.equal(youtubeCoolingDown?.(yt.fetchImpl), true);
  assert.equal(youtubeCoolingDown?.(fakeYouTube().fetchImpl), false);
});

test("a refresh after a failed download asks YouTube again", async (t) => {
  const yt = fakeYouTube();
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl);
  await resolveYouTubeAudio(SONG, undefined, yt.fetchImpl, { fresh: true });
  t.diagnostic(JSON.stringify(yt.counts()));
  assert.equal(yt.count("player"), 2);
  assert.equal(yt.count("page"), 1);
});

test("a lookup stopped by its caller doesn't stop the one it shares", async () => {
  const yt = fakeYouTube();
  const controller = new AbortController();
  const stopped = resolveYouTubeAudio(SONG, controller.signal, yt.fetchImpl);
  const kept = resolveYouTubeVideo(SONG, undefined, yt.fetchImpl);
  controller.abort();
  await assert.rejects(stopped, { name: "AbortError" });
  const video = await kept;
  assert.equal(video.videoID, SONG);
});
