// video/remotion.config.ts — webpack override for the hero composition.
//
// The composition imports renderer code (`src/renderer/**`) so the hero
// video is the actual product rendered frame-by-frame, not an animated
// mock. Remotion's default bundler doesn't know about the `@renderer/*`
// path alias tsconfig.json declares, so we wire it into webpack here. Same
// alias resolution as vitest.config.ts so unit tests + Remotion's bundle
// stay in lockstep.
//
// Two pieces:
//
//   1. `resolve.alias.@renderer` → `../src/renderer`. Mirrors tsconfig.json's
//      `paths` so the same import paths the unit tests resolve.
//
//   2. `resolve.extensionAlias` maps `.js` → `.ts`. The renderer imports
//      `../shared/net/state.js` (TypeScript's standard `.js` rewrite for
//      `.ts` source); webpack's default resolver doesn't auto-resolve that
//      to `state.ts` so we teach it here. Same trick Vite + esbuild do
//      out-of-the-box; webpack needs an explicit alias.

import { Config } from "@remotion/cli/config";
import path from "node:path";

// `__dirname` in Remotion's config loader doesn't resolve to the location
// of this file — Remotion patches it to its own internal path. Walk up from
// the working directory instead: this file lives at `<cwd>/remotion.config.ts`,
// the renderer at `<cwd>/../src/renderer/`.
const PROJECT_ROOT = process.cwd();
const RENDERER_DIR = path.resolve(PROJECT_ROOT, "../src/renderer");

Config.overrideWebpackConfig((currentConfig) => {
  return {
    ...currentConfig,
    resolve: {
      ...currentConfig.resolve,
      alias: {
        ...(currentConfig.resolve?.alias ?? {}),
        "@renderer": RENDERER_DIR,
      },
      extensionAlias: {
        ...(currentConfig.resolve?.extensionAlias ?? {}),
        ".js": [".ts", ".tsx", ".js"],
      },
    },
  };
});
