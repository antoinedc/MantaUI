import { defineConfig } from "vitest/config";

// mobile-rn is a self-contained Expo workspace with its own node_modules and
// its own vitest install. Without this file, vitest walks UP to the repo-root
// `vitest.config.ts`, which imports `vitest/config` from the root node_modules
// (not installed in the mobile-rn context) and fails to load. Pinning `root`
// here stops the upward search and scopes collection to the RN pure tests.
export default defineConfig({
  test: {
    root: __dirname,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
