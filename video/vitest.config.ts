import { defineConfig } from "vitest/config";

// video/ has its own lockfile and its own Remotion deps. CI does NOT run
// `npm run video` (it only runs the root `npm test`), so the root vitest
// config excludes video/** — this file makes `cd video && npm test` work
// for a developer iterating on the composition.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});