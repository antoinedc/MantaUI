import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Same package.json#version injection as electron.vite.config.ts so the
// mobile renderer bundle knows the build version it shipped with — fallback
// for getClientVersion when there's no Electron preload to ask.
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  define: {
    __MANTA_AXIOM_TOKEN__: JSON.stringify(process.env.MANTA_AXIOM_TOKEN ?? ""),
    __MANTA_AXIOM_DATASET__: JSON.stringify(process.env.MANTA_AXIOM_DATASET ?? "manta"),
    __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
    // BET-370 + BET-373: the mobile bundle currently always bakes "prod"
    // (mobile has no channel concept yet — out of scope per BET-373). Kept
    // here so the ambient `const __MANTA_CHANNEL__: string` in
    // src/renderer/types.d.ts is satisfied in BOTH renderer targets; a
    // future mobile-channel effort can flip this to read the real env var.
    __MANTA_CHANNEL__: JSON.stringify(process.env.MANTA_CHANNEL ?? "prod"),
  },
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  build: {
    outDir: resolve(__dirname, "mobile/www"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
  },
});
