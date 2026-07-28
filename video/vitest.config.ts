import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// video/ has its own lockfile and its own Remotion deps. CI does NOT run
// `npm run video` (it only runs the root `npm test`), so the root vitest
// config excludes video/** — this file makes `cd video && npm test` work
// for a developer iterating on the composition.
//
// Stage 2 mounts the renderer (src/renderer/**) inside the composition so
// the hero video is the actual product, not an animated mock. Three
// aliases pin resolution to `video/node_modules/*`:
//
//   - `@renderer/*` mirrors tsconfig.json's `paths` so vitest resolves
//     the same import paths the composition uses at render time.
//
//   - `react`, `react-dom`, `zustand` pin to the video project's
//     copies. Without these, `src/renderer/store.ts`'s `useStore`
//     resolves to `root/node_modules/react` while `createRoot` (in the
//     test) resolves to `video/node_modules/react` — two React copies
//     means two dispatchers, and the renderer's first hook call throws
//     "Cannot read properties of null (reading 'useRef')". The aliases
//     are explicit (rather than relying on npm dedupe) because
//     `npm run video` runs `cd video && npm install` fresh — npm will
//     happily re-install `react@18.3.1` into `video/node_modules`
//     even though the root already has it.
//
// happy-dom gives us a browser-like `self` + `window` so xterm's UMD
// wrapper (which reads `self` at module load) doesn't crash the test
// loader.
const RENDERER_DIR = resolve(__dirname, "../src/renderer");
const REACT_DIR = resolve(__dirname, "node_modules/react");
const REACT_DOM_DIR = resolve(__dirname, "node_modules/react-dom");
const ZUSTAND_DIR = resolve(__dirname, "node_modules/zustand");
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@renderer": RENDERER_DIR,
      react: REACT_DIR,
      "react-dom": REACT_DOM_DIR,
      zustand: ZUSTAND_DIR,
    },
  },
});