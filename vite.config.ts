import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { slopifyApi } from "./server/api.mjs";

// The online service (cloud/) and its Clerk sign-in, if this build has them (see docs/cloud.md).
const release = JSON.parse(readFileSync(new URL("./release.config.json", import.meta.url), "utf8")) as { cloudUrl?: string; shareUrl?: string; clerkPublishableKey?: string };
const cloud = {
  url: process.env.SLOPIFY_CLOUD_URL ?? release.cloudUrl ?? "",
  // Where shared playlists' links open (cloud/share-site/), when it isn't the service itself. A build pointed at
  // another service (SLOPIFY_CLOUD_URL) shares links of that service's own.
  shareUrl: process.env.SLOPIFY_SHARE_URL ?? (process.env.SLOPIFY_CLOUD_URL ? "" : release.shareUrl ?? ""),
  clerkPublishableKey: process.env.SLOPIFY_CLERK_PUBLISHABLE_KEY ?? release.clerkPublishableKey ?? "",
};

export default defineConfig({
  plugins: [
    react(),
    slopifyApi({ cloudUrl: cloud.url }),
    {
      // The built app's online service, for the music server that serves it (server/main.mjs):
      // it passes the app's calls on to that service, and only to that one.
      name: "slopify-cloud-config",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "cloud.json", source: JSON.stringify({ url: cloud.url }) });
      },
    },
  ],
  define: { __SLOPIFY_CLOUD__: JSON.stringify(cloud) },
  server: { port: 5199, watch: { ignored: ["**/data/**"] } },
  preview: { port: 5199 },
});
