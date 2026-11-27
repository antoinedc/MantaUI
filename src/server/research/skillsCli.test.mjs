// Architect v2 Stage 2 (docs/superpowers/specs/2026-11-27-architect-v2.md §4.2): the `skills` research source — a pinned local install of
// the `skills` CLI, run as argv with no shell. The CLI's output below is what 1.9.1 printed for `find "react best practices"` (cut);
// nothing here reaches the network or runs npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS_CLI_VERSION, SKILLS_FIND_TIMEOUT_MS, stripAnsi, parseInstalls, parseFindOutput, createSkillsFinder } from "./skillsCli.mjs";

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

// a world: what is installed under the tools folder, every command run
async function world({ installed = false, findOut = FIXTURE, installFails = false, findFails = null } = {}) {
  const base = await mkdtemp(join(tmpdir(), "skills-cli-"));
  const toolsRoot = join(base, "tools", "skills");
  const w = { runs: [], installed };
  const putPackage = async (version) => {
    await mkdir(join(toolsRoot, "node_modules", "skills", "bin"), { recursive: true });
    await writeFile(join(toolsRoot, "node_modules", "skills", "package.json"), JSON.stringify({ name: "skills", version }));
    await writeFile(join(toolsRoot, "node_modules", "skills", "bin", "cli.mjs"), "// the cli");
  };
  if (installed) await putPackage(installed === true ? SKILLS_CLI_VERSION : installed);
  const exec = async (file, args, opts) => {
    w.runs.push({ file, args, opts });
    if (file === "npm") {
      if (installFails) throw Object.assign(new Error("npm blew up"), { code: 1 });
      await putPackage(SKILLS_CLI_VERSION);
      return { stdout: "" };
    }
    if (findFails) throw findFails;
    return { stdout: findOut };
  };
  const finder = createSkillsFinder({ toolsRoot, exec, home: join(base, "h"), pathEnv: "/usr/bin", nodePath: "/opt/node/bin/node", log: { warn: () => {} } });
  return { w, finder, toolsRoot, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("the pinned version is 1.9.1 and a find has a 40 second timeout", () => {
  assert.equal(SKILLS_CLI_VERSION, "1.9.1");
  assert.equal(SKILLS_FIND_TIMEOUT_MS, 40_000);
});

test("first use installs the pinned version with npm --prefix; the find runs node on the installed bin with argv [find, query], no shell, 40 s, telemetry off; the second use installs nothing", async () => {
  const x = await world();
  try {
    const first = await x.finder.find("react best practices");
    assert.equal(first.results.length, 3);
    const install = x.w.runs[0];
    assert.equal(install.file, "npm");
    assert.deepEqual(install.args.slice(0, 3), ["install", "--prefix", x.toolsRoot]);
    assert.ok(install.args.includes(`skills@${SKILLS_CLI_VERSION}`));
    assert.ok(install.args.includes("--ignore-scripts"));
    const run = x.w.runs[1];
    assert.equal(run.file, "/opt/node/bin/node");
    assert.deepEqual(run.args, [join(x.toolsRoot, "node_modules", "skills", "bin", "cli.mjs"), "find", "react best practices"]);
    assert.equal(run.opts.shell, false);
    assert.equal(run.opts.timeout, 40_000);
    assert.equal(run.opts.env.DISABLE_TELEMETRY, "1");
    await x.finder.find("another query");
    assert.equal(x.w.runs.filter((r) => r.file === "npm").length, 1, "installed once");
    assert.equal(x.w.runs.length, 3);
  } finally {
    await x.cleanup();
  }
});

test("an install of another version is replaced by the pinned one", async () => {
  const x = await world({ installed: "1.8.0" });
  try {
    await x.finder.find("q");
    assert.equal(x.w.runs[0].file, "npm");
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

test("colour in the CLI's output is stripped; no results is an empty list with a note", async () => {
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
