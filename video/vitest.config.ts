import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// video/ has its own lockfile and its own Remotion deps. CI does NOT run
// `npm run video` (it only runs the root `npm test`), so the root vitest
// config excludes video/** — this file makes `cd video && npm test` work
// for a developer iterating on the composition.
//
// Stage 2 mounts the renderer (src/renderer/**) inside the composition so
// the hero video is the actual product, not an animated mock. The alias
// mirrors tsconfig.json's `@renderer/*` path so vitest can resolve the
// same import paths the composition uses at render time. happy-dom gives
// us a browser-like `self` + `window` so xterm's UMD wrapper (which reads
// `self` at module load) doesn't crash the test loader.
const RENDERER_DIR = resolve(__dirname, "../src/renderer");
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@renderer": RENDERER_DIR,
    },
  },
});