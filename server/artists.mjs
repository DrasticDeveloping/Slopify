import { setTimeout as delay } from "node:timers/promises";

const normalize = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+-\s+topic$|vevo$/giu, "").replace(/[^\p{L}\p{N}]/gu, "");
const text = (v, max = 6000) => typeof v === "string" ? v.trim().slice(0, max) : "";
const image = (v) => { try { const u = new URL(v); return u.protocol === "https:" ? u.href : undefined; } catch { return undefined; } };
const UA = "Slopify/2.0 (https://github.com/DrasticDeveloping/Slopify)";
const releaseArt = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id ?? "") ? `https://coverartarchive.org/release-group/${id}/front-250` : undefined;

/** Public artist metadata. Exact identities only; collaboration credits are labelled individually. */
export function createArtists({ fetchImpl = fetch, now = Date.now, wait = delay } = {}) {
  const cache = new Map();
  const pending = new Map();
  const hosts = new Map();
  function request(url, signal) {
    const host = hosts.get(url.hostname) ?? { queue: Promise.resolve(), last: 0, until: 0 };
    hosts.set(url.hostname, host);
    const task = host.queue.then(async () => {
      signal.throwIfAborted();
      if (host.until > now()) throw new Error("Metadata provider is temporarily rate limited.");
      await wait(Math.max(0, (url.hostname.includes("theaudiodb") ? 2100 : 1500) - (now() - host.last)), undefined, { signal });
      host.last = now();
      const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), headers: { Accept: "application/json", "User-Agent": UA } });
      if (response.status === 429 || response.status === 503) host.until = now() + 60_000;
      if (!response.ok) { void response.body?.cancel(); throw new Error(`Metadata HTTP ${response.status}`); }
      if (Number(response.headers.get("content-length")) > 2_000_000) { void response.body?.cancel(); throw new Error("Metadata too large"); }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 2_000_000) throw new Error("Metadata too large"); chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    });
    host.queue = task.catch(() => {});
    return task;
  }
  const audio = (path, params, signal) => {
    const url = new URL(`https://www.theaudiodb.com/api/v1/json/123/${path}.php`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return request(url, signal);
  };
  async function biography(name, signal) {
    let partial = false;
    for (const title of [`${name} (musician)`, name]) {
      try {
        const data = await request(new URL(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`), signal);
        if (data.type === "disambiguation" || normalize(data.title?.replace(/\s*\([^)]*\)$/, "")) !== normalize(name) || !/musician|producer|band|singer|songwriter|disc jockey|duo|DJ\b/i.test(`${data.description} ${data.extract}`)) continue;
        return { biography: text(data.extract), image: image(data.thumbnail?.source), biographyUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title)}`, partial };
      } catch (error) { if (!String(error?.message).includes("404")) partial = true; }
    }
    return { partial };
  }
  async function lookup(name, signal, musicBrainzId) {
    const clean = name.replace(/\s+-\s+Topic$|VEVO$/giu, "").trim();
    let row;
    try { const data = await audio("search", { s: clean }, signal); row = data.artists?.find((a) => (!musicBrainzId || a.strMusicBrainzID?.toLowerCase() === musicBrainzId) && [a.strArtist, a.strArtistAlternate].some((n) => normalize(n) === normalize(clean))); } catch { /* MusicBrainz fallback below. */ }
    const result = { name: clean, biography: "", genres: [], country: "", formed: "", formedLabel: "Active since", image: undefined, banner: undefined, sourceUrl: "", tracks: [], releases: [], partial: false };
    if (row) {
      Object.assign(result, { name: text(row.strArtist, 180), biography: text(row.strBiographyEN), genres: [text(row.strGenre, 100), text(row.strStyle, 100)].filter(Boolean), country: text(row.strCountry, 100), formed: text(row.intFormedYear, 20), image: image(row.strArtistThumb), banner: image(row.strArtistFanart), sourceUrl: `https://www.theaudiodb.com/artist/${encodeURIComponent(row.idArtist)}` });
      const [top, albums] = await Promise.allSettled([audio("track-top10", { s: result.name }, signal), audio("album", { i: row.idArtist }, signal)]);
      result.partial = top.status === "rejected" || albums.status === "rejected";
      if (top.status === "fulfilled") result.tracks = (top.value.track ?? []).filter((t) => normalize(t.strArtist) === normalize(result.name) && text(t.strTrack)).slice(0, 10).map((t) => ({ title: text(t.strTrack, 250), artist: result.name, album: text(t.strAlbum, 250), artwork: image(t.strTrackThumb), sourceUrl: `https://www.theaudiodb.com/track/${encodeURIComponent(t.idTrack)}` }));
      if (albums.status === "fulfilled") result.releases = (albums.value.album ?? []).filter((a) => normalize(a.strArtist) === normalize(result.name) && text(a.strAlbum)).slice(0, 60).map((a) => ({ id: `audiodb-${a.idAlbum}`, title: text(a.strAlbum, 250), artist: result.name, year: text(a.intYearReleased, 20), type: text(a.strReleaseFormat, 50), artwork: image(a.strAlbumThumb), sourceUrl: `https://www.theaudiodb.com/album/${encodeURIComponent(a.idAlbum)}` }));
      if (/^[a-f0-9-]{36}$/i.test(row.strMusicBrainzID ?? "")) {
        try {
          const data = await request(new URL(`https://musicbrainz.org/ws/2/release-group?artist=${row.strMusicBrainzID}&limit=50&fmt=json`), signal);
          const covers = new Map(result.releases.map((a) => [normalize(a.title), a.artwork]));
          const groups = (data["release-groups"] ?? []).map((a) => ({ id: `mb-${a.id}`, title: text(a.title, 250), artist: result.name, year: a["first-release-date"]?.slice(0, 4) ?? "", type: a["primary-type"] ?? "Release", artwork: covers.get(normalize(a.title)) || releaseArt(a.id), sourceUrl: `https://musicbrainz.org/release-group/${a.id}` }));
          if (groups.length) result.releases = groups;
        } catch { result.partial = true; }
      }
      if (!result.biography) { const extra = await biography(result.name, signal); result.biography = extra.biography ?? ""; result.biographyUrl = extra.biographyUrl; result.image ??= extra.image; result.partial ||= extra.partial; }
      return result;
    }
    try {
      const url = new URL("https://musicbrainz.org/ws/2/artist/");
      url.searchParams.set("query", `artist:"${clean.replace(/[\\"]/g, "\\$&")}"`); url.searchParams.set("fmt", "json"); url.searchParams.set("limit", "10");
      const data = musicBrainzId ? { artists: [await request(new URL(`https://musicbrainz.org/ws/2/artist/${musicBrainzId}?fmt=json`), signal)] } : await request(url, signal);
      const exact = (data.artists ?? []).filter((a) => musicBrainzId ? a.id === musicBrainzId : normalize(a.name) === normalize(clean));
      if (exact.length !== 1) return null;
      const artist = exact[0];
      Object.assign(result, { name: artist.name, country: artist.area?.name ?? artist.country ?? "", formed: artist["life-span"]?.begin ?? "", formedLabel: artist.type === "Person" ? "Born" : "Formed", genres: (artist.tags ?? []).slice(0, 4).map((t) => t.name), sourceUrl: `https://musicbrainz.org/artist/${artist.id}` });
      const [detail, releases] = await Promise.allSettled([
        request(new URL(`https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`), signal),
        request(new URL(`https://musicbrainz.org/ws/2/release-group?artist=${artist.id}&limit=50&fmt=json`), signal),
      ]);
      result.partial = detail.status === "rejected" || releases.status === "rejected";
      if (releases.status === "fulfilled") result.releases = (releases.value["release-groups"] ?? []).map((a) => ({ id: `mb-${a.id}`, title: a.title, artist: artist.name, year: a["first-release-date"]?.slice(0, 4) ?? "", type: a["primary-type"] ?? "Release", artwork: releaseArt(a.id), sourceUrl: `https://musicbrainz.org/release-group/${a.id}` }));
      const wiki = detail.status === "fulfilled" ? (detail.value.relations ?? []).find((r) => r.type === "wikipedia" && r.url?.resource?.startsWith("https://en.wikipedia.org/wiki/")) : undefined;
      if (wiki) {
        try {
          const title = new URL(wiki.url.resource).pathname.slice(6);
          const summary = await request(new URL(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`), signal);
          result.biography = text(summary.extract); result.image = image(summary.thumbnail?.source); result.biographyUrl = wiki.url.resource;
        } catch { result.partial = true; }
      } else { const extra = await biography(result.name, signal); result.partial ||= extra.partial; result.biography = extra.biography ?? ""; result.biographyUrl = extra.biographyUrl; result.image ??= extra.image; }
      return result;
    } catch { return result.sourceUrl ? result : null; }
  }
  async function profile(body) {
    const name = text(body?.name, 181);
    if (!name || name.length > 180 || ["unknownartist", "localfiles", "variousartists"].includes(normalize(name))) throw Object.assign(new Error("Send a real artist name."), { status: 400 });
    const musicBrainzId = typeof body?.musicBrainzId === "string" ? body.musicBrainzId.toLowerCase() : undefined;
    if (musicBrainzId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(musicBrainzId)) throw Object.assign(new Error("Invalid artist identity."), { status: 400 });
    const key = `${normalize(name)}:${musicBrainzId || ""}`;
    const hit = cache.get(key); if (hit && hit.until > now()) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const signal = AbortSignal.timeout(45_000);
      let profiles = [];
      const exact = await lookup(name, signal, musicBrainzId);
      if (exact) profiles = [exact];
      else if (!musicBrainzId) {
        const parts = name.split(/\s*(?:&|,|\bfeat\.?\s|\bft\.?\s|\band\b)\s*/iu).filter(Boolean).slice(0, 3);
        if (parts.length > 1) for (const part of parts) { const found = await lookup(part, signal); if (found) profiles.push(found); }
      }
      const value = { status: profiles.length ? profiles.some((p) => p.partial) ? "partial" : "available" : "unavailable", collaboration: profiles.length > 0 && normalize(profiles[0].name) !== normalize(name), profiles };
      cache.set(key, { value, until: now() + (value.status === "available" ? 86_400_000 : 60_000) });
      while (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }
  async function search(body, signal = AbortSignal.timeout(20_000)) {
    const query = text(body?.query, 181);
    if (!query || query.length > 180) throw Object.assign(new Error("Enter an artist name (up to 180 characters)."), { status: 400 });
    const key = `search:${normalize(query)}`;
    const hit = cache.get(key); if (hit && hit.until > now()) return hit.value;
    const url = new URL("https://musicbrainz.org/ws/2/artist/");
    url.searchParams.set("query", `artist:"${query.replace(/[\\"]/g, "\\$&")}"`);
    url.searchParams.set("fmt", "json"); url.searchParams.set("limit", "8");
    const [mb, adb] = await Promise.allSettled([request(url, signal), audio("search", { s: query }, signal)]);
    signal.throwIfAborted();
    if (mb.status === "rejected" && adb.status === "rejected") throw Object.assign(new Error("Artist search is temporarily unavailable. Try again."), { status: 503 });
    const audioRows = adb.status === "fulfilled" ? adb.value.artists ?? [] : [];
    const results = mb.status === "fulfilled" ? (mb.value.artists ?? []).filter((a) => text(a.name) && /^[a-f0-9-]{36}$/i.test(a.id ?? "") && Number(a.score) >= 50).map((a) => {
      const row = audioRows.find((r) => r.strMusicBrainzID?.toLowerCase() === a.id.toLowerCase());
      return { id: `mb-${a.id}`, musicBrainzId: a.id, name: text(a.name, 180), image: image(row?.strArtistThumb), description: [text(a.disambiguation, 250), text(a.type, 40), text(a.area?.name || a.country, 100)].filter(Boolean).join(" · "), sourceUrl: `https://musicbrainz.org/artist/${a.id}` };
    }) : [];
    for (const row of audioRows) {
      const musicBrainzId = text(row.strMusicBrainzID, 36).toLowerCase();
      const hasIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(musicBrainzId);
      if (!text(row.strArtist) || results.some((a) => hasIdentity ? a.musicBrainzId === musicBrainzId : normalize(a.name) === normalize(row.strArtist))) continue;
      results.push({ id: `audiodb-${text(row.idArtist, 30)}`, ...(hasIdentity ? { musicBrainzId } : {}), name: text(row.strArtist, 180), image: image(row.strArtistThumb), description: [text(row.strGenre, 100), text(row.strCountry, 100)].filter(Boolean).join(" · "), sourceUrl: `https://www.theaudiodb.com/artist/${encodeURIComponent(row.idArtist)}` });
    }
    results.sort((a, b) => Number(normalize(b.name) === normalize(query)) - Number(normalize(a.name) === normalize(query)));
    const value = { artists: results.slice(0, 8), partial: mb.status === "rejected" || adb.status === "rejected" };
    cache.set(key, { value, until: now() + (value.partial ? 60_000 : 600_000) });
    while (cache.size > 100) cache.delete(cache.keys().next().value);
    return value;
  }
  return { profile, search };
}
