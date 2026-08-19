import { defineConfig, configDefaults } from "vitest/config";
// @ts-expect-error — plain .mjs helper, no types; see scripts/testSandbox.mjs.
import { sandboxStateHome } from "./scripts/testSandbox.mjs";

export default defineConfig({
  test: {
    // Point every worker's box-state directory at a throwaway dir. Renderer
    // tests don't touch ~/.manta today, but src/shared/** is imported by both
    // sides and nothing stops a future vitest test from pulling in a server
    // module — which, unsandboxed, would read and WRITE the live box's stores
    // (credentials, secrets, schedules). See scripts/testSandbox.mjs for the
    // incident that motivated this.
    env: { MANTA_STATE_HOME: sandboxStateHome() },
    // src/server/**, src/main/*.test.mjs, src/gateway/** and scripts/** use
    // node:test (run via `node --test`), not vitest. .claude/** holds Claude
    // Code worktrees — nested copies of this repo (incl. their own *.test.mjs)
    // that vitest must not collect. video/** has its own lockfile + deps
    // (Remotion) and its own vitest config; the root resolver has no remotion
    // on its node_modules path, so root vitest must NOT collect video tests.
    exclude: [
      ...configDefaults.exclude,
      "src/server/**",
      // node:test files under src/main — the .mjs ones only (the existing
      // .test.ts vitest files in that dir stay collected). See
      // src/main/callWindow.test.mjs.
      "src/main/**/*.test.mjs",
      // node:test files under src/shared (run via `node --test`) — the .ts
      // vitest tests in the same dir stay collected. Only the .mjs ones.
      "src/shared/**/*.test.mjs",
      "src/gateway/**",
      "scripts/**",
      ".claude/**",
      "video/**",
    ],
  },
});
