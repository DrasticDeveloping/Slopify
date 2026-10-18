"use strict";

/*
 * Turns YouTube's downloads into an ordinary MP4 without ffmpeg (the iPhone app
 * has none): the picture and sound files are joined into one when they come
 * separately, and a sound file alone is rewritten the same way. YouTube sends
 * fragmented MP4s (a moov that only describes each track, then moof + mdat
 * pairs each holding a few seconds), and iOS misreads their length at first
 * (showing double), so the result is a plain one instead: ftyp, a moov with full
 * sample tables, then one mdat. Nothing is re-encoded; each run of samples
 * becomes one chunk, the tracks' chunks in playing order.
 */
const fs = require("node:fs/promises");
const { LocalImportError } = require("./local-import-core.cjs");

const COPY_CHUNK = 1024 * 1024;

const notJoinable = (message) => new LocalImportError("processing", "MP4_JOIN_UNSUPPORTED", `The download couldn't be made into a playable file: ${message}`);

/* ───────────────────────── reading boxes ───────────────────────── */

/** The boxes in buf between start and end. */
function children(buf, start = 0, end = buf.length) {
  const boxes = [];
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw notJoinable("a box runs past its end.");
    boxes.push({ type: buf.toString("latin1", at + 4, at + 8), at, size, header });
    at += size;
  }
  return boxes;
}

const inside = (buf, parent) => children(buf, parent.at + parent.header, parent.at + parent.size);

function child(buf, parent, type) {
  return inside(buf, parent).find((entry) => entry.type === type) || null;
}

function descend(buf, parent, ...types) {
  let found = parent;
  for (const type of types) found = found && child(buf, found, type);
  return found;
}

const bytes = (buf, entry) => buf.subarray(entry.at, entry.at + entry.size);
const version = (buf, entry) => buf[entry.at + entry.header];
const flags = (buf, entry) => buf.readUInt32BE(entry.at + entry.header) & 0xffffff;

/** Where a full box's field sits, after its version and flags, for the version 0 and 1 layouts. */
const field = (buf, entry, v0, v1) => entry.at + entry.header + 4 + (version(buf, entry) === 1 ? v1 : v0);

/** A time field: 4 bytes in version 0, 8 in version 1. */
const readTime = (buf, entry, v0, v1) => (version(buf, entry) === 1 ? Number(buf.readBigUInt64BE(field(buf, entry, v0, v1))) : buf.readUInt32BE(field(buf, entry, v0, v1)));
function writeTime(buf, entry, v0, v1, value) {
  if (version(buf, entry) === 1) buf.writeBigUInt64BE(BigInt(Math.round(value)), field(buf, entry, v0, v1));
  else buf.writeUInt32BE(Math.min(Math.round(value), 0xffffffff), field(buf, entry, v0, v1));
}

/** The top-level boxes of a file, read from disk only as far as their headers. */
async function topBoxes(handle) {
  const { size: total } = await handle.stat();
  const boxes = [];
  const head = Buffer.alloc(16);
  for (let at = 0; at < total;) {
    head.fill(0);
    await handle.read(head, 0, 16, at);
    let size = head.readUInt32BE(0);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = total - at;
    if (size < 8 || at + size > total) throw notJoinable("the file is cut short.");
    boxes.push({ type: head.toString("latin1", 4, 8), at, size });
    at += size;
  }
  return boxes;
}

async function load(handle, { at, size }) {
  const buf = Buffer.alloc(size);
  await handle.read(buf, 0, size, at);
  return buf;
}

/* ───────────────────────── writing boxes ───────────────────────── */

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

function fullBox(type, versionValue, ...parts) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE((versionValue & 0xff) << 24);
  return box(type, head, ...parts);
}

function u32s(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => (value < 0 ? buf.writeInt32BE(value, i * 4) : buf.writeUInt32BE(value, i * 4)));
  return buf;
}

/** A table box: its entry count, then each row's 32-bit values. */
const table = (type, rows, versionValue = 0) => fullBox(type, versionValue, u32s([rows.length, ...rows.flat()]));

/** Copies a container box; `replace(type, entry)` gives a child's new bytes, null to leave it out, or undefined to keep it. */
function rebuild(buf, parent, replace) {
  const parts = inside(buf, parent).map((entry) => {
    const next = replace(entry.type, entry);
    return next === undefined ? bytes(buf, entry) : next;
  }).filter(Boolean);
  return box(parent.type, ...parts);
}

/* ───────────────────────── one input track ───────────────────────── */

/** One file's track: its moov, and every run of samples (one per trun) with where its bytes are. */
async function readTrack(handle) {
  const top = await topBoxes(handle);
  const moovBox = top.find((entry) => entry.type === "moov");
  if (!moovBox) throw notJoinable("a stream has no description.");
  const moov = await load(handle, moovBox);
  const root = children(moov)[0];
  const traks = inside(moov, root).filter((entry) => entry.type === "trak");
  if (traks.length !== 1) throw notJoinable("a stream has more than one track.");
  const trak = traks[0];
  const mdhd = descend(moov, trak, "mdia", "mdhd");
  const mvhd = child(moov, root, "mvhd");
  const trex = descend(moov, root, "mvex", "trex");
  if (!mdhd || !mvhd || !trex) throw notJoinable("a stream isn't fragmented.");
  const timescale = moov.readUInt32BE(field(moov, mdhd, 8, 16));
  if (!timescale) throw notJoinable("a stream has no timescale.");
  const trexAt = trex.at + trex.header + 4;
  const defaults = { duration: moov.readUInt32BE(trexAt + 8), size: moov.readUInt32BE(trexAt + 12), flags: moov.readUInt32BE(trexAt + 16) };

  const runs = [];
  let decodeTime = 0;
  for (const entry of top) {
    if (entry.type !== "moof") continue;
    const moof = await load(handle, entry);
    for (const traf of inside(moof, children(moof)[0]).filter((part) => part.type === "traf")) {
      const tfhd = child(moof, traf, "tfhd");
      if (!tfhd) throw notJoinable("a fragment has no header.");
      const tfhdFlags = flags(moof, tfhd);
      let at = tfhd.at + tfhd.header + 8;
      // Offsets count from the moof unless the fragment gives its own base.
      let base = entry.at;
      if (tfhdFlags & 0x01) { base = Number(moof.readBigUInt64BE(at)); at += 8; }
      if (tfhdFlags & 0x02) at += 4;
      const fragment = { ...defaults };
      if (tfhdFlags & 0x08) { fragment.duration = moof.readUInt32BE(at); at += 4; }
      if (tfhdFlags & 0x10) { fragment.size = moof.readUInt32BE(at); at += 4; }
      if (tfhdFlags & 0x20) fragment.flags = moof.readUInt32BE(at);
      const tfdt = child(moof, traf, "tfdt");
      if (tfdt) decodeTime = readTime(moof, tfdt, 0, 0);

      let next = null;
      for (const trun of inside(moof, traf).filter((part) => part.type === "trun")) {
        const runFlags = flags(moof, trun);
        const count = moof.readUInt32BE(trun.at + trun.header + 4);
        let p = trun.at + trun.header + 8;
        const read = (signed = false) => {
          const value = signed ? moof.readInt32BE(p) : moof.readUInt32BE(p);
          p += 4;
          return value;
        };
        let offset = next ?? base;
        if (runFlags & 0x01) offset = base + read(true);
        const firstFlags = runFlags & 0x04 ? read() : null;
        const run = { start: decodeTime / timescale, offset, size: 0, durations: [], sizes: [], sync: [], composition: [] };
        for (let i = 0; i < count; i++) {
          const duration = runFlags & 0x100 ? read() : fragment.duration;
          const size = runFlags & 0x200 ? read() : fragment.size;
          let sampleFlags = runFlags & 0x400 ? read() : fragment.flags;
          if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
          const composition = runFlags & 0x800 ? read(version(moof, trun) === 1) : 0;
          run.durations.push(duration);
          run.sizes.push(size);
          run.sync.push(!(sampleFlags & 0x00010000));
          run.composition.push(composition);
          run.size += size;
          decodeTime += duration;
        }
        next = offset + run.size;
        if (count) runs.push(run);
      }
    }
  }
  if (!runs.length) throw notJoinable("a stream has no samples.");
  return { handle, moov, root, trak, mvhd, timescale, movieTimescale: moov.readUInt32BE(field(moov, mvhd, 8, 16)), runs };
}

/* ───────────────────────── the joined moov ───────────────────────── */

/** Run-length rows: [[count, value], …]. */
function runLengths(values) {
  const rows = [];
  for (const value of values) {
    const last = rows[rows.length - 1];
    if (last && last[1] === value) last[0]++;
    else rows.push([1, value]);
  }
  return rows;
}

/** A track's sample tables, its chunks starting at `chunkOffsets`. */
function sampleTable(track, chunkOffsets) {
  const stbl = descend(track.moov, track.trak, "mdia", "minf", "stbl");
  const stsd = stbl && child(track.moov, stbl, "stsd");
  if (!stsd) throw notJoinable("a stream doesn't say how it's encoded.");
  const all = (key) => track.runs.flatMap((run) => run[key]);
  const sizes = all("sizes");
  const sync = all("sync");
  const composition = all("composition");

  const stsc = [];
  track.runs.forEach((run, i) => {
    if (stsc[stsc.length - 1]?.[1] !== run.sizes.length) stsc.push([i + 1, run.sizes.length, 1]);
  });
  const sameSize = sizes.every((size) => size === sizes[0]);
  const parts = [
    bytes(track.moov, stsd),
    table("stts", runLengths(all("durations"))),
    table("stsc", stsc),
    fullBox("stsz", 0, u32s(sameSize ? [sizes[0], sizes.length] : [0, sizes.length, ...sizes])),
  ];
  if (composition.some(Boolean)) parts.push(table("ctts", runLengths(composition), composition.some((value) => value < 0) ? 1 : 0));
  if (sync.some((value) => !value)) parts.push(table("stss", sync.flatMap((value, i) => (value ? [[i + 1]] : []))));
  if (chunkOffsets.some((offset) => offset > 0xffffffff)) {
    const co64 = Buffer.alloc(4 + chunkOffsets.length * 8);
    co64.writeUInt32BE(chunkOffsets.length);
    chunkOffsets.forEach((offset, i) => co64.writeBigUInt64BE(BigInt(offset), 4 + i * 8));
    parts.push(fullBox("co64", 0, co64));
  } else parts.push(table("stco", chunkOffsets.map((offset) => [offset])));
  return box("stbl", ...parts);
}

/** A track's trak with full sample tables and its real length, renumbered, in the joined file's movie timescale. */
function joinedTrak(track, trackID, movieTimescale, chunkOffsets) {
  const { moov } = track;
  const mediaDuration = track.runs.reduce((total, run) => total + run.durations.reduce((sum, value) => sum + value, 0), 0);
  const movieDuration = (mediaDuration * movieTimescale) / track.timescale;
  const trak = rebuild(moov, track.trak, (type, entry) => {
    if (type === "tkhd") {
      const tkhd = Buffer.from(bytes(moov, entry));
      const local = children(tkhd)[0];
      tkhd.writeUInt32BE(trackID, field(tkhd, local, 8, 16));
      writeTime(tkhd, local, 16, 24, movieDuration);
      return tkhd;
    }
    if (type === "edts") {
      const elst = child(moov, entry, "elst");
      if (!elst) return null;
      const copy = Buffer.from(bytes(moov, elst));
      const local = children(copy)[0];
      const wide = version(copy, local) === 1;
      const count = copy.readUInt32BE(local.at + local.header + 4);
      for (let i = 0, at = local.at + local.header + 8; i < count; i++, at += wide ? 20 : 12) {
        let duration = wide ? Number(copy.readBigUInt64BE(at)) : copy.readUInt32BE(at);
        const mediaTime = wide ? Number(copy.readBigInt64BE(at + 8)) : copy.readInt32BE(at + 4);
        // Zero means "the rest of the track" in a fragmented file; a plain one needs it spelled out.
        if (!duration && count === 1) duration = (Math.max(0, mediaDuration - Math.max(0, mediaTime)) * movieTimescale) / track.timescale;
        else duration = (duration * movieTimescale) / (track.movieTimescale || movieTimescale);
        if (wide) copy.writeBigUInt64BE(BigInt(Math.round(duration)), at);
        else copy.writeUInt32BE(Math.min(Math.round(duration), 0xffffffff), at);
      }
      return box("edts", copy);
    }
    if (type !== "mdia") return undefined;
    return rebuild(moov, entry, (mdiaType, mdiaEntry) => {
      if (mdiaType === "mdhd") {
        const mdhd = Buffer.from(bytes(moov, mdiaEntry));
        writeTime(mdhd, children(mdhd)[0], 12, 20, mediaDuration);
        return mdhd;
      }
      if (mdiaType !== "minf") return undefined;
      return rebuild(moov, mdiaEntry, (minfType) => (minfType === "stbl" ? sampleTable(track, chunkOffsets) : undefined));
    });
  });
  return { trak, movieDuration };
}

/** The joined moov: the first file's movie header, then each track (no mvex: the file isn't fragmented). */
function joinedMoov(tracks, offsets) {
  const first = tracks[0];
  const movieTimescale = first.movieTimescale || first.timescale;
  const traks = tracks.map((track, i) => joinedTrak(track, i + 1, movieTimescale, offsets[i]));
  const mvhd = Buffer.from(bytes(first.moov, first.mvhd));
  const local = children(mvhd)[0];
  if (!first.movieTimescale) mvhd.writeUInt32BE(movieTimescale, field(mvhd, local, 8, 16));
  writeTime(mvhd, local, 12, 20, Math.max(...traks.map((entry) => entry.movieDuration)));
  mvhd.writeUInt32BE(tracks.length + 1, mvhd.length - 4);
  return box("moov", mvhd, ...traks.map((entry) => entry.trak));
}

/* ───────────────────────── writing the file ───────────────────────── */

async function copyRange(from, to, at, size, signal) {
  const chunk = Buffer.alloc(Math.min(COPY_CHUNK, size));
  for (let done = 0; done < size;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    const { bytesRead } = await from.read(chunk, 0, Math.min(chunk.length, size - done), at + done);
    if (!bytesRead) throw notJoinable("a stream ended early.");
    await to.write(chunk, 0, bytesRead);
    done += bytesRead;
  }
}

/**
 * Writes `output`, an ordinary MP4 with the tracks of the fragmented MP4s at
 * `inputs`: the picture then the sound, or a sound file alone.
 */
async function joinMP4(inputs, output, signal) {
  const handles = [];
  try {
    const tracks = [];
    for (const input of inputs) {
      const handle = await fs.open(input, "r");
      handles.push(handle);
      tracks.push(await readTrack(handle));
    }
    const ftypBox = (await topBoxes(tracks[0].handle)).find((entry) => entry.type === "ftyp");
    if (!ftypBox) throw notJoinable("a stream has no file type.");
    const ftyp = await load(tracks[0].handle, ftypBox);

    // Every run in playing order (at the same moment, the earlier track first) becomes a chunk.
    const chunks = tracks.flatMap((track, t) => track.runs.map((run, i) => ({ t, i, run })))
      .sort((left, right) => left.run.start - right.run.start || left.t - right.t);
    const mediaSize = chunks.reduce((total, chunk) => total + chunk.run.size, 0);
    const mdatHeader = mediaSize + 8 > 0xffffffff ? 16 : 8;
    const offsetsFrom = (start) => {
      const offsets = tracks.map((track) => new Array(track.runs.length));
      let at = start;
      for (const chunk of chunks) {
        offsets[chunk.t][chunk.i] = at;
        at += chunk.run.size;
      }
      return offsets;
    };
    // The moov's size decides where the media starts, which can (once) change whether offsets need 64 bits.
    let moov = joinedMoov(tracks, offsetsFrom(0));
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = joinedMoov(tracks, offsetsFrom(ftyp.length + moov.length + mdatHeader));
      const settled = next.length === moov.length;
      moov = next;
      if (settled) break;
    }

    const out = await fs.open(output, "w");
    handles.push(out);
    await out.write(ftyp);
    await out.write(moov);
    const mdat = Buffer.alloc(mdatHeader);
    mdat.write("mdat", 4, "latin1");
    if (mdatHeader === 16) {
      mdat.writeUInt32BE(1);
      mdat.writeBigUInt64BE(BigInt(mediaSize + 16), 8);
    } else mdat.writeUInt32BE(mediaSize + 8);
    await out.write(mdat);
    for (const chunk of chunks) await copyRange(tracks[chunk.t].handle, out, chunk.run.offset, chunk.run.size, signal);
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}

/** An MP4's length in seconds from its movie header, or null. Used where there's no ffmpeg to ask. */
async function mp4Duration(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const moovBox = (await topBoxes(handle)).find((entry) => entry.type === "moov");
    if (!moovBox) return null;
    const moov = await load(handle, moovBox);
    const root = children(moov)[0];
    const mvhd = child(moov, root, "mvhd");
    if (!mvhd) return null;
    const timescale = moov.readUInt32BE(field(moov, mvhd, 8, 16));
    let duration = readTime(moov, mvhd, 12, 20);
    // A fragmented file may only give its length in mehd.
    const mehd = !duration && descend(moov, root, "mvex", "mehd");
    if (mehd) duration = readTime(moov, mehd, 0, 0);
    return timescale && duration && duration !== 0xffffffff ? duration / timescale : null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

module.exports = { joinMP4, mp4Duration };
