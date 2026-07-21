import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Build-time-injected client version. Mirrors package.json#version so the
// renderer always knows the version of the running app — used as a fallback
// by httpApi's getClientVersion on platforms where Electron's `app.getVersion()`
// is unavailable (mobile, web). On desktop httpApi prefers the live Electron
// `app.getVersion()` over the preload bridge, so this constant only matters
// for the renderer-side no-preload code path. Bumping the package.json
// version automatically propagates to every renderer build at the next
// `npm run build` / `npm run build:mobile`.
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    define: {
      __MANTA_AXIOM_TOKEN__: JSON.stringify(process.env.MANTA_AXIOM_TOKEN ?? ""),
      __MANTA_AXIOM_DATASET__: JSON.stringify(process.env.MANTA_AXIOM_DATASET ?? "manta"),
      __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
  },
});
