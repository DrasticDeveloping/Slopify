# Slopify's online service

`cloud/` is a separate server for what needs to work between people and computers: **accounts and profiles**, **your library following your account**, and **Listen Along**. It runs on Cloudflare Workers, separately from the music server each computer runs (`server/`), which still fetches and plays the audio.

| Part | Where | What it holds |
| --- | --- | --- |
| Accounts | Clerk (sign-in) + D1 table `users` | Display name, username, friend code and picture, by Clerk user id |
| Library | D1 tables `songs`, `library_state` | Saved songs as links and details (never audio), and one document of playlists, likes, history and settings |
| Listen Along | One Durable Object per room (`ListenAlongRoom`) | Who's in the room and what the host is playing; WebSockets, so changes arrive live |
| Friends and sharing | D1 tables `friends`, `friend_requests`, `activity`, `shared_playlists`, `playlist_follows`, `playlist_inbox` (`src/social.ts`) | Friend codes and friendships, what friends are playing, and shared playlists (songs as links) |

The service checks each request's Clerk session token against the Clerk app's public signing keys. It needs only the Clerk **Publishable Key**, never the secret key.

## How the app uses it

- **Signing in.** Profile menu → **Sign in**, or Settings → Account. The first sign-in creates the Slopify profile from the Clerk account's name and picture, with a username from the Clerk username or email address. Settings → Account changes the display name (anything) and the username (unique: 3 to 20 letters, numbers, `_` or `.`; `GET /v1/usernames/:name` checks it). Without a configured service, Slopify works as before, entirely on your computer.
- **Library sync.** The first account to sync links this computer's library to that account. Signing in to another account keeps its library sync off; Settings offers **Use with this account**, with confirmation before copying this library to that account. Linked accounts merge through `src/state/cloud-sync.ts` (songs) and `src/state/sync.ts` (playlists and preferences), using the same three-way merge as the music server. On another computer, songs from the account are added by link under the same ids, so playlists match; their audio is fetched when played. Songs added from files stay on their original computer.
- **When it syncs.** Soon after a change on this computer, at startup, sign-in and when the window comes back into focus, and every 30 seconds while the window has focus. Each check is one call, `GET /v1/sync`: song changes since the last check, the playlists-and-settings document (only its revision while it hasn't changed), and friends when they're due. A service without `/v1/sync` gets the separate calls as before. A window that's open but not focused, hidden or in the tray never checks the account on its own, so it costs no requests. Changes that arrive from the account go on to the music server without contacting the account again, and from this version on, settings added by a newer version of Slopify are kept as they are, so devices on different versions don't re-save the library at each other. Versions from before this (such as the 2026-10-22 nightly) still remove newer settings, so update them.
- **How calls travel.** The app calls the service through its own music server (`/api/cloud/v1/…` → `<service>/v1/…`, `proxyCloud` in `server/api.mjs`), so they come from the page's own origin and the browser sends no CORS check (`OPTIONS`) first. Cloudflare counts those as requests too, and the browser repeats them per address, at least every two hours. The server only passes calls to the service the web app was built for (`dist/cloud.json`, written by `vite.config.ts`). If it can't, the app calls the service directly as before. Listen Along's WebSocket still connects directly.
- **Deleting an account.** Settings → Account → **Delete account** deletes the profile and synced library (`DELETE /v1/me`), removes the account from its Listen Along rooms (ending the ones it hosts), unlinks this computer's library, and deletes the Clerk sign-in. For 15 minutes the service refuses writes for that account (D1 table `deleted_users`), so a sync another device had already started can't put the data back. The computer keeps its songs and playlists.
- **Friends.** The Friends page (sidebar) shows your friend code; adding someone's code or @username sends them a request. Friends see each other's profile playlists, what each is playing (Settings → Account → "Friends see what I'm playing"), and can join each other's Listen Along room in one click. The app fetches all of it at sign-in, on focus (unless it tried in the last 25 seconds) and every 30 seconds while focused, usually along with the library's check (`GET /v1/sync?social=1`) and otherwise on its own (`GET /v1/social`), and tells the service what you're playing when the song or pause state changes (and every 4 minutes while playing).
- **Shared playlists.** A playlist's Share button publishes it (its songs as links, like Listen Along) and gives a link, `<service>/p/<id>`. Pasting the link into the search bar opens it; opened in a browser it only explains that. Anyone signed in can play, follow (it shows in their library) or save a copy; only the owner changes it. The owner's app republishes it a few seconds after each change, so it stays live. Songs that are only files on the owner's computer aren't shared.
- **Listen Along.** Start a room and share its code. Guests play the host's song from its link on their own device (or their own copy if they have it), at the host's position, and follow pause, play and skips. Each guest's volume is their own. Songs that are only a file on the host's computer can't be shared.

## Set it up

The service is deployed at `https://slopify-cloud.gavdie01.workers.dev`, using the Slopify Clerk production instance (domain `slopify.unblocked.mov`, Frontend API `clerk.slopify.unblocked.mov`). Production keys only work from origins the instance allows, so the desktop app's `http://127.0.0.1:5197`/`5198` and the local web app's `http://localhost:5199` must be in its `allowed_origins` (set through Clerk's Backend API). `release.config.json` includes the service URL and public Clerk key. The steps below describe setup for another account; do not create a second database for the existing deployment.

### 1. Clerk

1. Create an application at <https://dashboard.clerk.com>. Enable **Email** sign-in. Google works in the browser; in the desktop app, use email (Google blocks sign-in inside embedded app windows).
2. Under **Domains / Allowed origins**, add the addresses Slopify runs from: `http://127.0.0.1:5197` (desktop app from a checkout), `http://127.0.0.1:5198` (installed desktop app), `http://127.0.0.1:5199` and `http://localhost:5199` (browser), plus any address you host the web app at.
3. Copy the **Publishable Key** (`pk_test_…` or `pk_live_…`).

### 2. Cloudflare

```powershell
cd cloud
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler d1 create slopify          # copy the database_id it prints into wrangler.jsonc
```

Put the Publishable Key in `cloud/wrangler.jsonc` under `vars.CLERK_PUBLISHABLE_KEY`, then:

```powershell
npm.cmd run db:migrate      # creates the tables in the remote database
npm.cmd run deploy          # prints the service's address, e.g. https://slopify-cloud.<you>.workers.dev
```

When updating the service later, run `npm.cmd run db:migrate` again before `npm.cmd run deploy`: a new version may need tables the old one didn't have. Migration `v3` (`wrangler.jsonc`) ended every Listen Along room open at the time: rooms from before it are removed, and people start a new one.

### 3. The app

In `release.config.json`, set `cloudUrl` to the service's address and `clerkPublishableKey` to the same Publishable Key. The next `npm run desktop`, `node server/main.mjs --open` or EXE build includes them (`SLOPIFY_CLOUD_URL` and `SLOPIFY_CLERK_PUBLISHABLE_KEY` override them for one build).

## Develop and test it locally

```powershell
cd cloud
npm.cmd run db:migrate:local
npm.cmd run dev             # http://127.0.0.1:8787
```

`cloud/.dev.vars` (not committed) may set `CLERK_JWT_KEY` to a PEM public key: the local service then accepts tokens signed with its private key instead of Clerk's, for tests. In the Vite dev server only (`npm run dev`), a token in localStorage `slopify.dev.cloud-token` stands in for Clerk sign-in (name: `slopify.dev.cloud-name`), with `SLOPIFY_CLOUD_URL=http://127.0.0.1:8787`. Built apps never read it.

## Limits

- The Free Workers plan allows 100,000 requests a day for the whole account, browsers' CORS checks (`OPTIONS`) included. A focused window uses about 3 requests every 30 seconds, and nothing while it isn't focused.
- To see where requests go: Cloudflare dashboard → Workers & Pages → slopify-cloud → Observability. The service logs one line per call (`method`, `route` with ids replaced by `:id`, `status`, `ms`); group by `route` and `method` to count them. Cloudflare's own per-call logs are off (`wrangler.jsonc` `observability`), since they would keep addresses and WebSocket tokens. Workers Logs allows 200,000 lines a day on the Free plan, more than the request limit.
- Each account may make 300 calls a minute, and each address 600 (wrangler.jsonc `ratelimits`); past that, calls get 429 and the app retries a minute later. A first sync sends one call per song, so a very large library takes a few minutes to upload.
- An account can keep up to 20,000 songs.
- Rooms hold 20 people. A room ends a minute after its host leaves, five minutes after everyone has, or a day after it started. Closing or reloading the app leaves its room at once: a guest drops off the list, and a host's room ends.
- Once a day (a cron trigger in `wrangler.jsonc`), the service removes deletion records older than 15 minutes, room records older than two days and listening activity older than a day.
- A shared playlist can have up to 2,000 songs; an account up to 500 friends and 100 unanswered requests it sent.
- The library document is limited to about 900 KB, which is many thousands of playlist entries.

## Backups

D1 keeps its own recovery points (Time Travel: 7 days on the Free plan, 30 on Paid), which can restore the database to any minute in that window: `npx.cmd wrangler d1 time-travel restore slopify --timestamp=<time>`. For a copy kept longer, run `npm.cmd run db:backup` in `cloud/`; it saves the whole database as SQL in `cloud/backups/` (ignored by git). Backups contain every account's personal data: keep them private, and delete them when they're no longer needed.

## Privacy

What the service keeps, and how people delete it, is in the [privacy policy](PRIVACY.md) and [terms](TERMS.md). Keep them up to date when the service starts keeping something new.
