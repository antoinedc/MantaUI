import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // src/server/**, src/gateway/** and scripts/** use node:test (run via
    // `node --test`), not vitest. .claude/** holds Claude Code worktrees —
    // nested copies of this repo (incl. their own *.test.mjs) that vitest
    // must not collect. video/** has its own lockfile + deps (Remotion) and
    // its own vitest config; the root resolver has no remotion on its
    // node_modules path, so root vitest must NOT collect video tests.
    exclude: [
      ...configDefaults.exclude,
      "src/server/**",
      "src/gateway/**",
      "scripts/**",
      ".claude/**",
      "video/**",
    ],
  },
});
