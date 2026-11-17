# Proof for PR #62

Captured on 2026-11-17 from this PR's head (a9b7e97) and master (006f28c), with local `wrangler dev` Workers, the real app (Vite dev, isolated data) in headless Edge, and this PR's Cloudflare preview Worker.

- Sign-in used a throwaway RSA key made for this run (`CLERK_JWT_KEY` in a local `.dev.vars`) and the app's dev-only test token. Every token is shown as `<test token>`, and Listen Along room codes as `<code>`.
- `proof-probe` is a made-up name, used only for this proof. `logs/probe-harness.diff` and `logs/app-new-harness.diff` show the temporary patches. They are not part of the PR.

Files:
- `logs/`: the raw transcripts and the Worker log lines shown in the images.
- `scripts/`: the scripts that made the requests, drove the browser and rendered the images. The key and token are not included.

`scripts/app.mjs`'s room-code pattern left a suffix in place (`<code>-5PEU`). `logs/app.txt` was cleaned afterwards with `sed -E 's#<code>-[A-Z0-9]+#<code>#g'`. Nothing else was edited.
