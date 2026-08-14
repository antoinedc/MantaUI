// selfhost.test.mjs — the layered host→kind detection (BET-799 §Self-hosted).
// Pins that known hosts resolve through the shared detector unchanged, unknown
// hosts resolve ONLY via a configured `forgeHosts` entry, apiBase follows the
// per-host rule, and `src/shared/forge.mjs` is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectForgeWithHosts, parseRemotePath, defaultApiBase } from "./selfhost.mjs";

test("a known host resolves exactly as before, with its canonical apiBase", () => {
  const github = detectForgeWithHosts("git@github.com:acme/widget.git", []);
  assert.deepEqual(github, {
    kind: "github",
    host: "github.com",
    owner: "acme",
    repo: "widget",
    apiBase: "https://api.github.com",
  });

  const gitlab = detectForgeWithHosts("https://gitlab.com/group/sub/proj.git", []);
  assert.deepEqual(gitlab, {
    kind: "gitlab",
    host: "gitlab.com",
    owner: "group/sub",
    repo: "proj",
    apiBase: "https://gitlab.com/api/v4",
  });
});

test("an unknown host is null UNLESS configured in the host→kind list", () => {
  // No config → unresolved (the shared contract: never guess).
  assert.equal(detectForgeWithHosts("git@git.example.com:acme/widget.git", []), null);

  const hosts = [{ host: "git.example.com", kind: "gitlab" }];
  const r = detectForgeWithHosts("git@git.example.com:acme/widget.git", hosts);
  assert.deepEqual(r, {
    kind: "gitlab",
    host: "git.example.com",
    owner: "acme",
    repo: "widget",
    apiBase: "https://git.example.com/api/v4",
  });
});

test("a configured apiBase overrides the derivation default", () => {
  const hosts = [{ host: "git.example.com", kind: "gitlab", apiBase: "https://git.example.com/api/v4" }];
  const r = detectForgeWithHosts("https://git.example.com/acme/widget", hosts);
  assert.equal(r.apiBase, "https://git.example.com/api/v4");
});

test("nested subgroup owner survives for a configured self-hosted gitlab", () => {
  const hosts = [{ host: "git.example.com", kind: "gitlab" }];
  const r = detectForgeWithHosts("https://git.example.com/team/platform/shared.git", hosts);
  assert.equal(r.owner, "team/platform");
  assert.equal(r.repo, "shared");
});

test("a config entry with an unknown kind is ignored (never coerce a typo)", () => {
  const hosts = [{ host: "git.example.com", kind: "gitea" }];
  assert.equal(detectForgeWithHosts("git@git.example.com:acme/widget.git", hosts), null);
});

test("defaultApiBase: hosted canonical, self-hosted conventional mounts", () => {
  assert.equal(defaultApiBase("github", "github.com"), "https://api.github.com");
  assert.equal(defaultApiBase("gitlab", "gitlab.com"), "https://gitlab.com/api/v4");
  assert.equal(defaultApiBase("gitlab", "git.example.com"), "https://git.example.com/api/v4");
  assert.equal(defaultApiBase("github", "git.example.com"), "https://git.example.com/api/v3");
});

test("parseRemotePath handles https, ssh, scp and trailing slash forms", () => {
  assert.deepEqual(parseRemotePath("https://git.example.com/a/b/"), { host: "git.example.com", owner: "a", repo: "b" });
  assert.deepEqual(parseRemotePath("ssh://git@git.example.com/a/b.git"), { host: "git.example.com", owner: "a", repo: "b" });
  assert.equal(parseRemotePath(""), null);
  assert.equal(parseRemotePath("/a/b"), null, "a local absolute path is not a git remote");
  assert.equal(parseRemotePath(null), null);
});
