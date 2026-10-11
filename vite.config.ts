import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { slopifyApi } from "./server/api.mjs";

export default defineConfig({
  plugins: [react(), slopifyApi()],
  server: { port: 5199, watch: { ignored: ["**/data/**"] } },
  preview: { port: 5199 },
});
