import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // src/server/** uses node:test (run via `node --test`), not vitest.
    // .claude/** holds Claude Code worktrees — nested copies of this repo
    // (incl. their own src/server/*.test.mjs) that vitest must not collect.
    exclude: [...configDefaults.exclude, "src/server/**", ".claude/**"],
  },
});
