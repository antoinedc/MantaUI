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
    // Build-time-injected channel id (BET-370). The release pipeline sets
    // MANTA_CHANNEL=prod|staging for packaged builds; `npm run dev` leaves
    // it unset so the main process falls back to "prod" baked value AND
    // resolveChannel() itself overrides with "dev" when app.isPackaged is
    // false. Defensive reference in main/index.ts:
    // `typeof __MANTA_CHANNEL__ === "string" ? __MANTA_CHANNEL__ : "prod"`
    // exists because an unbuilt / unprocessed main bundle has no define
    // inlined — TypeScript would refuse an unknown identifier. The ambient
    // declaration lives in src/main/buildDefines.d.ts.
    define: {
      __MANTA_CHANNEL__: JSON.stringify(process.env.MANTA_CHANNEL ?? "prod"),
    },
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
      // BET-370 + BET-373: bake the channel id into the renderer bundle so
      // pairPayload.ts (and any future renderer-side consumer) can pull the
      // channel's URL scheme through `channelConfig(__MANTA_CHANNEL__)`.
      // Mirrors the main-process baking — same source (process.env), same
      // fallback ("prod"). The mobile renderer bundle bakes the SAME global
      // (electron.vite.config.mobile.ts) so the ambient type is satisfied in
      // both targets; mobile currently always uses the prod scheme because
      // the mobile app does not yet have a channel concept (a separate
      // effort per BET-373's out-of-scope list).
      __MANTA_CHANNEL__: JSON.stringify(process.env.MANTA_CHANNEL ?? "prod"),
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
