import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/*
 * The audio-data hash: a hash of a song's first encoded sound frames, not of
 * its file. Tagging, adding a cover, or rewriting YouTube's fragmented MP4 as a
 * plain one (all of which change the file, and so its SHA-256) copy the frames
 * as they are, so the same recording hashes the same either way. It needs only
 * the start of the stream: about the first 8 seconds of sound.
 *
 * Reads MP4 (fragmented, as YouTube sends it, or plain, as Slopify saves it) and
 * MP3 (as SoundCloud sends it). Anything else has no audio-data hash.
 */

/** How much encoded sound is hashed (about 8 seconds at YouTube's and SoundCloud's 128 kbps). */
export const PAYLOAD_BYTES = 128 * 1024;
/** Enough of a stream's start to hold PAYLOAD_BYTES of sound after its headers. */
export const PAYLOAD_PREFIX_BYTES = 192 * 1024;
const VERSION = "a1";

const bufferReader = (buf) => ({
  size: buf.length,
  read: async (at, length) => buf.subarray(Math.min(at, buf.length), Math.min(buf.length, at + length)),
});

async function fileReader(handle) {
  const { size } = await handle.stat();
  return {
    size,
    read: async (at, length) => {
      const n = Math.max(0, Math.min(length, size - at));
      const buf = Buffer.alloc(n);
      if (n) await handle.read(buf, 0, n, at);
      return buf;
    },
  };
}

/* ───────────────────────── MP4 ───────────────────────── */

/** The boxes in buf between start and end; one that runs past the end stops the list. */
function kids(buf, start = 0, end = buf.length) {
  const boxes = [];
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) break;
    boxes.push({ type: buf.toString("latin1", at + 4, at + 8), at, size, header });
    at += size;
  }
  return boxes;
}
const inner = (buf, box) => kids(buf, box.at + box.header, box.at + box.size);
const find = (buf, box, type) => (box ? inner(buf, box).find((k) => k.type === type) || null : null);
const descend = (buf, box, ...types) => types.reduce((current, type) => find(buf, current, type), box);
/** Where a full box's own fields start, after its version and flags. */
const body = (box) => box.at + box.header + 4;

/** The file's top-level boxes, read as far as their headers. A box cut off by the end of a prefix is still listed. */
async function topBoxes(reader) {
  const boxes = [];
  for (let at = 0; at + 8 <= reader.size && boxes.length < 20_000;) {
    const head = await reader.read(at, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = Number.MAX_SAFE_INTEGER - at;
    if (size < header) break;
    boxes.push({ type: head.toString("latin1", 4, 8), at, size, header });
    at += size;
  }
  return boxes;
}

const MP4_TOP = new Set(["ftyp", "styp", "moov", "sidx", "moof", "mdat", "free", "skip", "wide", "uuid", "pdin"]);

/** The sound track of a moov: its id, codec and (for a plain MP4) sample table. */
function soundTrack(moov, header) {
  const root = { type: "moov", at: 0, size: moov.length, header };
  for (const trak of inner(moov, root).filter((k) => k.type === "trak")) {
    const hdlr = descend(moov, trak, "mdia", "hdlr");
    if (!hdlr || moov.toString("latin1", body(hdlr) + 4, body(hdlr) + 8) !== "soun") continue;
    const tkhd = find(moov, trak, "tkhd");
    if (!tkhd) continue;
    const id = moov.readUInt32BE(body(tkhd) + (moov[tkhd.at + tkhd.header] === 1 ? 16 : 8));
    const stbl = descend(moov, trak, "mdia", "minf", "stbl");
    const stsd = find(moov, stbl, "stsd");
    const codec = stsd && stsd.size >= 24 ? moov.toString("latin1", body(stsd) + 8, body(stsd) + 12) : "????";
    return { id, codec: codec.replace(/[^\x20-\x7e]/g, "_"), stbl, root };
  }
  return null;
}

/** The byte ranges of a plain MP4 track's first samples (from its stsz, stsc and stco/co64 tables). */
function plainSamples(moov, stbl, wanted) {
  const stsz = find(moov, stbl, "stsz");
  const stsc = find(moov, stbl, "stsc");
  const stco = find(moov, stbl, "stco");
  const co64 = find(moov, stbl, "co64");
  if (!stsz || !stsc || (!stco && !co64)) return null;
  const fixed = moov.readUInt32BE(body(stsz));
  const count = moov.readUInt32BE(body(stsz) + 4);
  const sizeAt = (i) => (fixed || moov.readUInt32BE(body(stsz) + 8 + i * 4));
  const offsets = co64 || stco;
  const chunks = moov.readUInt32BE(body(offsets));
  const offsetAt = (c) => (co64 ? Number(moov.readBigUInt64BE(body(co64) + 4 + c * 8)) : moov.readUInt32BE(body(stco) + 4 + c * 4));
  const runs = moov.readUInt32BE(body(stsc));
  const run = (r) => ({ first: moov.readUInt32BE(body(stsc) + 4 + r * 12), perChunk: moov.readUInt32BE(body(stsc) + 8 + r * 12) });
  const samples = [];
  let total = 0;
  let sample = 0;
  for (let r = 0; r < runs && total < wanted; r++) {
    const { first, perChunk } = run(r);
    const last = r + 1 < runs ? run(r + 1).first - 1 : chunks;
    for (let c = first; c <= last && c <= chunks && total < wanted; c++) {
      let at = offsetAt(c - 1);
      for (let s = 0; s < perChunk && sample < count && total < wanted; s++, sample++) {
        const size = sizeAt(sample);
        samples.push({ at, size });
        at += size;
        total += size;
      }
    }
  }
  return samples;
}

/** The byte ranges of a fragmented MP4 track's first samples, from its moof boxes. */
async function fragmentedSamples(reader, top, moov, track, wanted) {
  const trex = inner(moov, descend(moov, track.root, "mvex") || { at: 0, size: 0, header: 0 })
    .filter((k) => k.type === "trex")
    .find((k) => moov.readUInt32BE(body(k)) === track.id);
  const defaultSize = trex ? moov.readUInt32BE(body(trex) + 12) : 0;
  const samples = [];
  let total = 0;
  for (const entry of top) {
    if (total >= wanted) break;
    if (entry.type !== "moof") continue;
    const moof = await reader.read(entry.at, entry.size);
    if (moof.length < entry.size) break;
    const root = { type: "moof", at: 0, size: moof.length, header: entry.header };
    for (const traf of inner(moof, root).filter((k) => k.type === "traf")) {
      const tfhd = find(moof, traf, "tfhd");
      if (!tfhd || moof.readUInt32BE(body(tfhd)) !== track.id) continue;
      const tfhdFlags = moof.readUInt32BE(tfhd.at + tfhd.header) & 0xffffff;
      let p = body(tfhd) + 4;
      let base = entry.at;
      if (tfhdFlags & 0x01) { base = Number(moof.readBigUInt64BE(p)); p += 8; }
      if (tfhdFlags & 0x02) p += 4;
      if (tfhdFlags & 0x08) p += 4;
      let size = defaultSize;
      if (tfhdFlags & 0x10) size = moof.readUInt32BE(p);
      let next = null;
      for (const trun of inner(moof, traf).filter((k) => k.type === "trun")) {
        const flags = moof.readUInt32BE(trun.at + trun.header) & 0xffffff;
        const count = moof.readUInt32BE(body(trun));
        let q = body(trun) + 4;
        let at = next ?? base;
        if (flags & 0x01) { at = base + moof.readInt32BE(q); q += 4; }
        if (flags & 0x04) q += 4;
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) q += 4;
          let sampleSize = size;
          if (flags & 0x200) { sampleSize = moof.readUInt32BE(q); q += 4; }
          if (flags & 0x400) q += 4;
          if (flags & 0x800) q += 4;
          if (total < wanted) {
            samples.push({ at, size: sampleSize });
            total += sampleSize;
          }
          at += sampleSize;
        }
        next = at;
      }
    }
  }
  return samples;
}

async function mp4Payload(reader) {
  const top = await topBoxes(reader);
  if (!top.length || !MP4_TOP.has(top[0].type)) return null;
  const moovBox = top.find((k) => k.type === "moov");
  if (!moovBox) return null;
  const moov = await reader.read(moovBox.at, moovBox.size);
  if (moov.length < moovBox.size) return null;
  const track = soundTrack(moov, moovBox.header);
  if (!track) return null;
  const fragmented = Boolean(descend(moov, track.root, "mvex"));
  const samples = fragmented
    ? await fragmentedSamples(reader, top, moov, track, PAYLOAD_BYTES)
    : plainSamples(moov, track.stbl, PAYLOAD_BYTES);
  return samples ? { codec: track.codec, samples } : null;
}

/* ───────────────────────── MP3 ───────────────────────── */

const BITRATES = {
  // [MPEG version 1 | 2 (and 2.5)][layer I, II, III], in kbit/s.
  1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** An MP3 frame header at `at`: its length and whether it is mono, or null. */
function mp3Frame(buf, at) {
  if (at + 4 > buf.length) return null;
  const h = buf.readUInt32BE(at);
  if ((h >>> 21) !== 0x7ff) return null;
  const version = (h >>> 19) & 3;
  const layer = (h >>> 17) & 3;
  const bitrateIndex = (h >>> 12) & 15;
  const rateIndex = (h >>> 10) & 3;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layerIndex = 3 - layer; // 0: I, 1: II, 2: III
  const bitrate = BITRATES[version === 3 ? 1 : 2][layerIndex][bitrateIndex] * 1000;
  const rate = SAMPLE_RATES[version][rateIndex];
  const padding = (h >>> 9) & 1;
  const length = layerIndex === 0
    ? Math.floor((12 * bitrate) / rate + padding) * 4
    : Math.floor(((layerIndex === 2 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
  return length >= 24 ? { length, mono: ((h >>> 6) & 3) === 3, mpeg1: version === 3, layer3: layerIndex === 2 } : null;
}

/** Whether a frame is the encoder's Xing/Info/VBRI header, which holds no sound (and which converters drop). */
function infoFrame(buf, at, frame) {
  if (!frame.layer3) return false;
  const side = frame.mpeg1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17);
  const tag = buf.toString("latin1", at + 4 + side, at + 8 + side);
  return tag === "Xing" || tag === "Info" || buf.toString("latin1", at + 36, at + 40) === "VBRI";
}

async function mp3Payload(reader) {
  const head = await reader.read(0, 10);
  let start = 0;
  if (head.length === 10 && head.toString("latin1", 0, 3) === "ID3") {
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    start = 10 + size + (head[5] & 0x10 ? 10 : 0);
  }
  const buf = await reader.read(start, PAYLOAD_BYTES * 2 + 64 * 1024);
  const samples = [];
  let total = 0;
  let at = 0;
  let skipped = 0;
  let first = true;
  while (at < buf.length && total < PAYLOAD_BYTES) {
    const frame = mp3Frame(buf, at);
    // A frame counts once the next one follows it, so stray sync bits in other data aren't taken for one.
    const confirmed = frame && (at + frame.length >= buf.length || mp3Frame(buf, at + frame.length));
    if (!confirmed) {
      if (++skipped > 64 * 1024) return null;
      at += 1;
      continue;
    }
    if (!(first && infoFrame(buf, at, frame))) {
      samples.push({ at: start + at, size: frame.length });
      total += frame.length;
    }
    first = false;
    at += frame.length;
  }
  return samples.length ? { codec: "mp3", samples } : null;
}

/* ───────────────────────── the hash ───────────────────────── */

async function payloadFrom(reader) {
  const head = await reader.read(0, 12);
  if (head.length < 12) return null;
  const parsed = MP4_TOP.has(head.toString("latin1", 4, 8)) ? await mp4Payload(reader) : await mp3Payload(reader);
  if (!parsed?.samples.length) return null;
  const hash = createHash("sha256").update(`${VERSION}|${parsed.codec}|`);
  const distinct = new Set();
  let total = 0;
  for (const { at, size } of parsed.samples) {
    const take = Math.min(size, PAYLOAD_BYTES - total);
    if (take <= 0) break;
    const bytes = await reader.read(at, take);
    // Cut off by the end of a prefix: there isn't enough of the stream to hash.
    if (bytes.length < take) return null;
    hash.update(bytes);
    if (take === size) distinct.add(createHash("sha1").update(bytes).digest("base64"));
    total += take;
  }
  if (total < PAYLOAD_BYTES) return null;
  // Silence encodes to the same few frames over and over, and two songs that open with it would hash alike.
  if (distinct.size < Math.max(16, parsed.samples.length * 0.5)) return null;
  return `${VERSION}:${parsed.codec}:${hash.digest("hex")}`;
}

/** The audio-data hash of a stream's first bytes (at least PAYLOAD_PREFIX_BYTES of it), or null. */
export async function payloadHashOfBuffer(buf) {
  try {
    return await payloadFrom(bufferReader(buf));
  } catch {
    return null;
  }
}

/** The audio-data hash of a file on disk, or null. */
export async function payloadHashOfFile(filePath) {
  let handle = null;
  try {
    handle = await fs.open(filePath, "r");
    return await payloadFrom(await fileReader(handle));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
