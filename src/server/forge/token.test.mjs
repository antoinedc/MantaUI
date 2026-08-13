import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { resolveForgeToken } from "./token.mjs";
import { loadSecrets, saveSecrets } from "../secrets.mjs";

test("resolveForgeToken returns the per-host env var", () => {
  const env = { MANTA_GITHUB_TOKEN: "ghp_envtoken" };
  assert.equal(resolveForgeToken("github.com", { env, loadSecretsFn: () => [] }), "ghp_envtoken");
  assert.equal(resolveForgeToken("gitlab.com", { env: { MANTA_GITLAB_TOKEN: "glpat_x" }, loadSecretsFn: () => [] }), "glpat_x");
});

test("resolveForgeToken falls back to a shared secret in the box secrets vault", async () => {
  const path = join(tmpdir(), `manta-token-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await saveSecrets(
      [
        { id: "s1", key: "github.token", value: "ghp_vault", scope: "shared", sessionID: null, project: null, createdAt: 0, updatedAt: 0 },
      ],
      path,
    );
    const loadSecretsFn = () => loadSecrets(path);
    // No env var → reads the vault.
    assert.equal(resolveForgeToken("github.com", { env: {}, loadSecretsFn }), "ghp_vault");
  } finally {
    await rm(path, { force: true });
  }
});

test("resolveForgeToken returns null with no env var and no stored secret", () => {
  assert.equal(resolveForgeToken("github.com", { env: {}, loadSecretsFn: () => [] }), null);
  assert.equal(resolveForgeToken("", { env: {}, loadSecretsFn: () => [] }), null);
  assert.equal(resolveForgeToken("unknown.example.com", { env: {}, loadSecretsFn: () => [] }), null);
});
