# Slopify's online service

`cloud/` is a separate server for what needs to work between people and computers: **accounts and profiles**, **your library following your account**, and **Listen Along**. It runs on Cloudflare Workers, separately from the music server each computer runs (`server/`), which still fetches and plays the audio.

| Part | Where | What it holds |
| --- | --- | --- |
| Accounts | Clerk (sign-in) + D1 table `users` | Display name and picture, by Clerk user id |
| Library | D1 tables `songs`, `library_state` | Saved songs as links and details (never audio), and one document of playlists, likes, history and settings |
| Listen Along | One Durable Object per room (`ListenRoom`) | Who's in the room and what the host is playing; WebSockets, so changes arrive live |

The service checks each request's Clerk session token against the Clerk app's public signing keys. It needs only the Clerk **Publishable Key**, never the secret key.

## How the app uses it

- **Signing in.** Profile menu → **Sign in**, or Settings → General → Account. The first sign-in creates the Slopify profile from the Clerk account's name and picture; the name can be changed there. Without a configured service, Slopify works as before, entirely on your computer.
- **Library sync.** The first account to sync links this computer's library to that account. Signing in to another account keeps its library sync off; Settings offers **Use with this account**, with confirmation before copying this library to that account. Linked accounts merge through `src/state/cloud-sync.ts` (songs) and `src/state/sync.ts` (playlists and preferences), using the same three-way merge as the music server. On another computer, songs from the account are added by link under the same ids, so playlists match; their audio is fetched when played. Songs added from files stay on their original computer.
- **Listen Along.** Start a room and share its code. Guests play the host's song from its link on their own device (or their own copy if they have it), at the host's position, and follow pause, play and skips. Each guest's volume is their own. Songs that are only a file on the host's computer can't be shared.

## Set it up

The service is deployed at `https://slopify-cloud.gavdie01.workers.dev`, using the Slopify Clerk development application. `release.config.json` includes the service URL and public Clerk key. The steps below describe setup for another account; do not create a second database for the existing deployment.

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

- Free Cloudflare plans include D1 and SQLite Durable Objects with daily request limits that are far above one group of friends' use.
- Rooms hold 20 people. A room ends a minute after its host leaves, or five minutes after everyone has.
- The library document is limited to about 900 KB, which is many thousands of playlist entries.
