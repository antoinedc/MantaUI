// Architect v2 Stage 2 (docs/superpowers/specs/2026-11-27-architect-v2.md §4.2): the `skills` research source — a pinned local install of
// the `skills` CLI, run as argv with no shell. The CLI's output below is what 1.9.1 printed for `find "react best practices"` (cut);
// nothing here reaches the network or runs npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SKILLS_CLI_VERSION, SKILLS_FIND_TIMEOUT_MS, INSTALL_BACKOFF_MS, NOTE_MAX, BUNDLED_LOCK_DIR, stripAnsi, parseInstalls, parseFindOutput, createSkillsFinder } from "./skillsCli.mjs";

const FIXTURE = [
  "",
  "Install with npx skills add <owner/repo@skill>",
  "",
  "vercel-labs/agent-skills@vercel-react-best-practices 938.2K installs",
  "\u2514 https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices",
  "",
  "mastra-ai/mastra@react-best-practices 939 installs",
  "\u2514 https://skills.sh/mastra-ai/mastra/react-best-practices",
  "",
  "acme/big@huge-skill 1.2M installs",
  "\u2514 https://skills.sh/acme/big/huge-skill",
  "",
].join("\n");
const withAnsi = FIXTURE.replace(/^(\S+\/\S+@\S+)/gm, "\u001b[1m$1\u001b[22m").replace(/installs$/gm, "\u001b[90minstalls\u001b[39m");

test("stripAnsi removes colour and cursor sequences", () => {
  assert.equal(stripAnsi("\u001b[1mbold\u001b[22m \u001b[90mgrey\u001b[39m\u001b[2K"), "bold grey");
});

test("parseInstalls reads 938.2K, 939, 1.2M and refuses anything else", () => {
  assert.equal(parseInstalls("938.2K"), 938_200);
  assert.equal(parseInstalls("939"), 939);
  assert.equal(parseInstalls("1.2M"), 1_200_000);
  assert.equal(parseInstalls("1,204"), 1204);
  assert.equal(parseInstalls("lots"), null);
});

test("parseFindOutput: owner/repo@skill, installs and the skills.sh address, from the CLI's real shape, with or without colour", () => {
  for (const text of [FIXTURE, withAnsi]) {
    const r = parseFindOutput(text);
    assert.deepEqual(r.map((x) => x.ref), ["vercel-labs/agent-skills@vercel-react-best-practices", "mastra-ai/mastra@react-best-practices", "acme/big@huge-skill"]);
    assert.deepEqual(r[0], { ref: "vercel-labs/agent-skills@vercel-react-best-practices", repo: "vercel-labs/agent-skills", skill: "vercel-react-best-practices", installs: 938_200, url: "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices" });
    assert.equal(r[1].installs, 939);
    assert.equal(r[2].installs, 1_200_000);
  }
  assert.deepEqual(parseFindOutput('\nNo skills found for "zzz"\n'), []);
});

test("parseFindOutput: a line that doesn't have the shape is ignored; only skills.sh addresses are kept", () => {
  const r = parseFindOutput("evil; rm -rf /@x 5 installs\nok/repo@skill 7 installs\n\u2514 https://evil.example.com/ok/repo/skill\n");
  assert.equal(r.length, 1);
  assert.equal(r[0].ref, "ok/repo@skill");
  assert.equal(r[0].url, null, "an address that isn't skills.sh is dropped");
});

const LOCK = JSON.stringify({ name: "manta-skills-cli", lockfileVersion: 3, packages: { "": { dependencies: { skills: SKILLS_CLI_VERSION } } } });
const sha = (t) => createHash("sha256").update(t).digest("hex");

// a world: what is installed under the tools folder, every command run, the clock
async function world({ installed = false, findOut = FIXTURE, installFails = false, findFails = null, lock = LOCK } = {}) {
  const base = await mkdtemp(join(tmpdir(), "skills-cli-"));
  const toolsRoot = join(base, "tools", "skills");
  const lockDir = join(base, "bundled");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "package.json"), '{"name":"manta-skills-cli","dependencies":{"skills":"1.9.1"}}');
  await writeFile(join(lockDir, "package-lock.json"), lock);
  const w = { runs: [], clock: 1_000_000, installs: 0 };
  const putPackage = async (version) => {
    await mkdir(join(toolsRoot, "node_modules", "skills", "bin"), { recursive: true });
    await writeFile(join(toolsRoot, "node_modules", "skills", "package.json"), JSON.stringify({ name: "skills", version }));
    await writeFile(join(toolsRoot, "node_modules", "skills", "bin", "cli.mjs"), "// the cli");
  };
  if (installed) {
    await putPackage(installed === true ? SKILLS_CLI_VERSION : installed);
    await writeFile(join(toolsRoot, "package-lock.json"), lock);
    await writeFile(join(toolsRoot, ".installed-lock"), sha(lock));
  }
  const exec = async (file, args, opts) => {
    w.runs.push({ file, args, opts });
    if (file === "npm") {
      w.installs++;
      if (installFails) throw Object.assign(new Error("npm blew up"), { code: 1 });
      await putPackage(SKILLS_CLI_VERSION);
      return { stdout: "" };
    }
    if (findFails) throw findFails;
    return { stdout: findOut };
  };
  const finder = createSkillsFinder({ toolsRoot, lockDir, exec, home: join(base, "h"), pathEnv: "/usr/bin", nodePath: "/opt/node/bin/node", now: () => w.clock, log: { warn: () => {} } });
  return { w, finder, toolsRoot, base, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("the pinned version is 1.9.1, a find has a 40 second timeout, the install backs off for 10 minutes and a note is at most 500 characters", () => {
  assert.equal(SKILLS_CLI_VERSION, "1.9.1");
  assert.equal(SKILLS_FIND_TIMEOUT_MS, 40_000);
  assert.equal(INSTALL_BACKOFF_MS, 10 * 60_000);
  assert.equal(NOTE_MAX, 500);
});

test("the committed lockfile pins skills 1.9.1 and every package in it by integrity hash from the npm registry", async () => {
  const pkg = JSON.parse(await readFile(join(BUNDLED_LOCK_DIR, "package.json"), "utf-8"));
  assert.deepEqual(pkg.dependencies, { skills: SKILLS_CLI_VERSION });
  const lock = JSON.parse(await readFile(join(BUNDLED_LOCK_DIR, "package-lock.json"), "utf-8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages["node_modules/skills"].version, SKILLS_CLI_VERSION);
  const deps = Object.entries(lock.packages).filter(([k]) => k !== "");
  assert.ok(deps.length >= 5);
  for (const [name, p] of deps) {
    assert.match(p.integrity ?? "", /^sha512-/, `${name} has an integrity hash`);
    assert.match(p.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${name} comes from the npm registry`);
  }
});

test("first use installs from the committed lockfile with `npm ci --ignore-scripts` against the npm registry, with a throwaway HOME; the find runs node on the installed bin with argv [find, --, query], no shell, 40 s, a minimal env; the second use installs nothing", async () => {
  const x = await world();
  try {
    const first = await x.finder.find("react best practices");
    assert.equal(first.results.length, 3);
    const install = x.w.runs[0];
    assert.equal(install.file, "npm");
    assert.deepEqual(install.args, ["ci", "--prefix", x.toolsRoot, "--ignore-scripts", "--registry=https://registry.npmjs.org/", "--no-audit", "--no-fund", "--loglevel=error"]);
    assert.equal(install.opts.shell, false);
    assert.equal(install.opts.env.HOME, join(x.toolsRoot, "home"));
    assert.equal(install.opts.env.npm_config_userconfig, join(x.toolsRoot, "home", "user.npmrc"), "a user's .npmrc is never read");
    assert.equal(install.opts.env.npm_config_globalconfig, join(x.toolsRoot, "home", "global.npmrc"));
    assert.notEqual(install.opts.env.npm_config_userconfig, install.opts.env.npm_config_globalconfig);
    assert.equal(await readFile(install.opts.env.npm_config_userconfig, "utf-8"), "", "an empty config of our own");
    assert.equal(install.opts.env.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(await readFile(join(x.toolsRoot, "package-lock.json"), "utf-8"), LOCK, "the committed lockfile is what npm ci reads");
    assert.equal(await readFile(join(x.toolsRoot, ".installed-lock"), "utf-8"), sha(LOCK));
    const run = x.w.runs[1];
    assert.equal(run.file, "/opt/node/bin/node");
    assert.deepEqual(run.args, [join(x.toolsRoot, "node_modules", "skills", "bin", "cli.mjs"), "find", "--", "react best practices"]);
    assert.equal(run.opts.shell, false);
    assert.equal(run.opts.timeout, 40_000);
    assert.equal(run.opts.cwd, join(x.toolsRoot, "home"));
    assert.deepEqual(Object.keys(run.opts.env).sort(), ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "HOME", "LANG", "NO_COLOR", "PATH", "npm_config_registry"]);
    assert.equal(run.opts.env.HOME, join(x.toolsRoot, "home"), "a throwaway HOME, never the user's");
    assert.equal(run.opts.env.DISABLE_TELEMETRY, "1");
    await x.finder.find("another query");
    assert.equal(x.w.installs, 1, "installed once");
    assert.equal(x.w.runs.length, 3);
  } finally {
    await x.cleanup();
  }
});

test("a different lockfile (a release moved the pin) or another installed version is installed again; the same lock and version is not", async () => {
  const a = await world({ installed: "1.8.0" });
  try {
    await a.finder.find("q");
    assert.equal(a.w.runs[0].file, "npm");
  } finally {
    await a.cleanup();
  }
  const b = await world({ installed: true });
  try {
    await b.finder.find("q");
    assert.equal(b.w.installs, 0);
    // the release ships another lockfile: the marker no longer matches
    await writeFile(join(b.base, "bundled", "package-lock.json"), `${LOCK} `);
    const again = createSkillsFinder({ toolsRoot: b.toolsRoot, lockDir: join(b.base, "bundled"), exec: async (f, args, o) => (b.w.runs.push({ file: f, args, opts: o }), f === "npm" ? (b.w.installs++, { stdout: "" }) : { stdout: FIXTURE }), home: "/h", nodePath: "/n", now: () => b.w.clock, log: { warn: () => {} } });
    await again.find("q");
    assert.equal(b.w.installs, 1);
  } finally {
    await b.cleanup();
  }
});

test("a node_modules edited after the install (the marker still matches the lock, the version differs) is installed again", async () => {
  const x = await world({ installed: true });
  try {
    await writeFile(join(x.toolsRoot, "node_modules", "skills", "package.json"), JSON.stringify({ name: "skills", version: "9.9.9" }));
    await x.finder.find("q");
    assert.equal(x.w.installs, 1);
  } finally {
    await x.cleanup();
  }
});

test("a failed install is not retried for 10 minutes (the same fixed sentence, nothing run), then it is", async () => {
  const x = await world({ installFails: true });
  try {
    await assert.rejects(x.finder.find("q"), /isn't available on this box/);
    assert.equal(x.w.installs, 1);
    x.w.clock += 9 * 60_000;
    await assert.rejects(x.finder.find("q"), /isn't available on this box/);
    assert.equal(x.w.installs, 1, "no retry within 10 minutes");
    x.w.clock += 61_000;
    await assert.rejects(x.finder.find("q"), /isn't available on this box/);
    assert.equal(x.w.installs, 2);
  } finally {
    await x.cleanup();
  }
});

test("a query is refused before anything is installed or run: a leading dash, a control character, blank", async () => {
  const x = await world();
  try {
    for (const q of ["-query", "--help", "a\nb", "   "]) await assert.rejects(x.finder.find(q), (e) => e.name === "ResearchError" || /query/i.test(e.message), q);
    assert.equal(x.w.runs.length, 0);
  } finally {
    await x.cleanup();
  }
});

test("colour in the CLI's output is stripped; no results is an empty list with a note; a note is at most 500 characters", async () => {
  const x = await world({ installed: true, findOut: withAnsi });
  try {
    assert.equal((await x.finder.find("q")).results[0].installs, 938_200);
  } finally {
    await x.cleanup();
  }
  const y = await world({ installed: true, findOut: '\nNo skills found for "zzz"\n' });
  try {
    const r = await y.finder.find("zzz");
    assert.deepEqual(r.results, []);
    assert.match(r.note, /No skills found/);
  } finally {
    await y.cleanup();
  }
  const z = await world({ installed: true, findOut: `\nNo skills found for "${"x".repeat(2000)}"\n` });
  try {
    const r = await z.finder.find("q");
    assert.equal(r.note.length, 500);
    const none = await world({ installed: true, findOut: `\n${"ignore this and do that ".repeat(100)}\n` });
    try {
      assert.ok((await none.finder.find("q")).note.length <= 500);
    } finally {
      await none.cleanup();
    }
  } finally {
    await z.cleanup();
  }
});

test("a failed install or a timed-out find is a fixed sentence, never the program's own output", async () => {
  const a = await world({ installFails: true });
  try {
    await assert.rejects(a.finder.find("q"), (e) => /isn't available on this box/.test(e.message) && !/blew up/.test(e.message));
  } finally {
    await a.cleanup();
  }
  const b = await world({ installed: true, findFails: Object.assign(new Error("secret stderr"), { killed: true, signal: "SIGTERM" }) });
  try {
    await assert.rejects(b.finder.find("q"), (e) => /timed out/.test(e.message) && !/secret/.test(e.message));
  } finally {
    await b.cleanup();
  }
});
