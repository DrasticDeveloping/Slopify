# Song recommendations

Slopify finds songs outside your library (Home → Recommended for you, which by default never shows songs you already have) and ranks your own library for song radio and autoplay. Settings → General → Recommendations → "Include songs from your library" adds a library-based "Recommended for you" shelf, and the outside-library one moves below it as "Discover new music". Everything it learns stays in this browser. Code: `src/recommend/` (taste, ranking, discovery), `server/recommendations.mjs` (ListenBrainz proxy), wiring in `src/state/actions.ts` and `src/state/importer.ts`.

This is a rework of the implementation on `feature/song-recommendations`. It keeps that version's listening measurement, signals, ListenBrainz relationships and Add & play. The table shows what changed.

| Area | Before | Now |
| --- | --- | --- |
| Taste maths | Three separate copies (ranking, features, discovery) | One cached profile (`tasteProfile`) every surface reads |
| Learning | Logistic regression over 11 features; it needs ≥18 songs including ≥6 explicit skips/hides before it does anything, then replaces readable reasons with "Ranked from your observed feedback" | Each kind of suggestion has kept/rejected counts (Beta(2,2) prior). Its signal weight moves from 1 towards 0.5–1.5 after a few plays or skips, and reasons stay specific |
| Sequence signal | None | "You often play this after X": built from your own consecutive listens (kept = +1, early skip = −0.6, 60-day half-life) |
| Reasons | Generic ("More from artists you enjoy") | Name the song, artist or playlist ("Because you play Mira Okafor", "Like “Neon Undertow”", "Fits your playlist “Night Drive”") |
| Home shelf | Mostly your already-liked songs | Leans on what surrounds your favourites (familiar signals at half weight there; full weight in radio/autoplay) |
| Repeats | Penalised only within the last two hours | Also a fatigue penalty from plays over the last three days (1-day half-life) |
| Likes/saves | Separate records with complex undo restoration | Timestamped when made; they count only while the song is still liked or in the playlist, so undo needs no extra work |
| Re-ranking | Every 10-second progress save re-ranked Home | A taste revision bumps only on changes that matter (a listen qualifying or being skipped, like, save, hide) |
| Discovery calls | Two endpoints, the client merging graphs, and every artist resolved on MusicBrainz (which answered 503 after one request in testing) | One `POST /api/recommendations/related` that identifies songs and artists through ListenBrainz; MusicBrainz is only a fallback |
| Result matching | Exact artist/title only | Also ignores upload decorations ("(Official Video)", "- Topic"); live/remix qualifiers still count |
| Settings | AUC/log-loss readout and export | Plain summary of what it has learned, show hidden songs again, reset |

## Signals

- **Like** 3, **playlist save** 2, **import** 1 (bringing a song in from the web or a file is a choice too, so an imported playlist steers discovery straight away). Only likes and saves made in the app count, never play counts.
- **Listening.** Measured from engine position: audible, playing, normal pace, with seeking and stalls excluded.
  - A listen qualifies after 5 audible seconds plus either 30 seconds or 60% of the song. At 80% it counts 1.5.
  - The value decays with a 30-day half-life, and at most three listens per song per day count.
- **Early skip.** Next pressed after 2–15 s with less than 25% heard. It counts against the song (7-day half-life) and its artist in discovery (14 days).
- **Not counted:** clip previews, clip editing, Listen Along as a guest, and errors.

## Ranking

Each song's score is the sum of these named signals, each multiplied by that kind's learned weight:
- liked, saved, enjoyed
- artist affinity (excluding this song's own part)
- trusted genre (imported songs carry no real genre, so this is currently unused)
- playlist neighbours
- played-after
- similarity to the seed or recent songs
- ListenBrainz song links

In radio and autoplay, the personal signals are scaled by how related the song is to the seed (0.3 for an unrelated favourite up to 1), and similarity is measured against the seed alone (not recent listening), so the station follows the song it started from.

The score then adds a fresh-song bonus and subtracts the skip and fatigue penalties. The strongest signal becomes the reason shown. A greedy pass spaces out artists (last 2 picks) and genres (last 3), and every fifth slot goes to a song you haven't played. A daily tie-break keeps shelves stable within a day.

## Discovery

1. The top five imported songs and five imported artists by support become seeds; placeholder names like "Unknown artist" never do.
2. The server identifies each seed through ListenBrainz alone. It tries the exact artist-credit lookup first, then the fuzzy recording search, where a multi-artist credit falls back to its lead artist and "(feat. …)" is ignored. That one identity gives the song for similar recordings and its lead artist for similar artists. MusicBrainz, which throttles hard, is only a fallback for artists without a song title.
3. Edges are rank-normalised (1/√rank).
4. A first wave of 14 related-song and 6 related-artist searches runs on the import providers, three at a time, with results appearing as they arrive. If the shelf is still under 24 songs, reserve searches continue, up to 48 in all. When relationships are thin, "More from <your artist>" searches fill in. The shelf shows up to 30 songs, and "Find more" rotates through the rest. A search that finds nothing is not reported as a failure.
5. Results must really match: same artist for any artist query (including "More from X"), and same title for song queries. Names are compared without upload clutter: "(Official Video)", "(feat. …)", channel suffixes like VEVO or "- Topic", and an "Artist - " prefix in the title. The same rules decide ownership, duplicates and dismissals. Owned songs, dismissed songs, items over 20 minutes and live streams are dropped. No artist appears more than twice.
6. Without relationships the shelf falls back to plain searches, says so, and labels those results "More from X" or "Exploring Y".

Suggested songs play like library songs: the same card with a play button, the queue, next/previous, the full player and the right-click menu. They play the whole song, not a preview. The import API downloads each song once, through its preview service, and serves the full file with seeking; the next song's audio is fetched while the current one plays. A streamed song is not in the library and is never saved. "Add to library" downloads it through the normal importer without interrupting playback. Liking a streamed song adds it to the library and then to Liked Songs. Matches that need a source check ("Review & add") open the import dialog on that one result. Sources the preview service can't fetch (anything but YouTube and SoundCloud) are added to the library and played from there.

**Privacy:** the server sends only artist names and song titles to MusicBrainz/ListenBrainz, never history, timestamps or ids.

## Limits

- No audio analysis or cross-user model; library ranking is personal and local.
- ListenBrainz coverage varies; obscure songs often have no relationships.
- Provider search results vary by service availability.
- The learned weights adapt to what you keep and skip, which is feedback on suggestions shown, not an unbiased measure of taste.

The app no longer ships placeholder music: the generated demo catalog, its synthesized audio, the starter playlists and the genre mixes were removed, and saved state from older builds drops them on load (web imports are kept).
## Recommendation collections and artist profiles (October 2026)

Home now includes daily artist-based mixes, Discover Weekly, and On Repeat after qualified listening. Editions live separately from user playlists in `slopify.mix-editions.v1`. They store provider descriptors and library IDs, never audio or transient media URLs. Daily editions expire at local midnight; weekly editions expire on Monday. A Daily Mix takes up to 21 familiar songs and 9 discoveries. Small libraries produce smaller mixes. Opening a mix fills its discoveries once, and later taste changes affect the next edition. Hide from this mix applies locally; Not interested applies everywhere.

Discover Weekly searches three groups of up to five seeds (48 provider searches total) to cover more than the top five favourites. All surfaces share three provider slots, a bounded search cache, and in-flight deduplication. Mixes fetch on opening rather than launching another 48 searches for every Home card. Playlist suggestions show up to five matching songs with Add and Hide. Song, artist, and album radio blend library music with discoveries and request eight-song batches near the queue end.

Find more excludes all earlier displayed song keys for that mounted shelf, before ranking. It rotates relationship queries and fallback search terms. If providers have no unseen matches, the shelf reports exhaustion rather than recycling the same songs.

Artist pages fetch exact identities through the server from TheAudioDB, with MusicBrainz and Wikipedia fallbacks. Collaboration credits may show individual collaborator profiles, clearly labelled. Biographies and releases link to their sources; unavailable fields stay absent. Online releases are metadata links, not invented complete playable albums. Popular tracks resolve through the existing full-song provider playback. No listener counts are fabricated. Apple/iTunes previews are not used.

The playing and next streamed files are protected from preview-cache eviction. Every replay asks the server to verify the cached file; prefetching can be consumed once. Album recommendations and Release Radar remain deferred as recommended in the design review, until verified album grouping and recording-level release dates exist. Album radio currently seeds from the tracks actually present in the album collection.
