// guidance-sync.test.mjs — node:test cases for sync_opencode_guidance in
// scripts/lib/release.sh and its JS twin scripts/release/guidance-history.mjs.
//
// Spec: docs/superpowers/specs/2026-10-27-guidance-section-refresh.md. The sync
// is exercised as the REAL shell function, under `set -euo pipefail` (as both
// callers run it), against temp dirs, with MANTA_STATE_HOME sandboxed so the
// manifest can never land in a live box's ~/.manta.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, historyLines, mergeHistory, parseSections } from "../release/guidance-history.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RELEASE_LIB = join(HERE, "release.sh");
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function tmp(prefix = "manta-guidance-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

const HELPERS = `
log()  { printf 'log: %s\\n' "$*"; }
ok()   { printf 'ok: %s\\n' "$*"; }
warn() { printf 'warn: %s\\n' "$*" >&2; }
die()  { printf 'die: %s\\n' "$*" >&2; exit 1; }
`;

function bash(script) {
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

const sec = (heading, body) => `${heading}\n\n${body}\n`;
const join2 = (...parts) => parts.join("\n"); // blank line between sections
const hashOf = (sectionText) => parseSections(sectionText)[0].hash;
const hist = (...entries) => entries.map(([h, text]) => `${h}\t${hashOf(text)}`).join("\n") + "\n";

/**
 * One sync against a fresh sandbox. Everything is optional except `src`.
 * `shadow` is bash injected after the helpers and before sourcing the lib
 * (used to make `mv` fail). Returns the files' final contents and the output.
 */
function scenario({ src, dest, history, aliases, manifest, shadow = "", runs = 1, after: afterHook } = {}) {
  const root = tmp();
  const srcDir = join(root, "src");
  const cfg = join(root, "cfg");
  const state = join(root, "state");
  mkdirSync(srcDir);
  mkdirSync(cfg);
  mkdirSync(join(state, ".manta"), { recursive: true });
  writeFileSync(join(srcDir, "AGENTS.md"), src);
  if (history !== undefined) writeFileSync(join(srcDir, "AGENTS.history"), history);
  if (aliases !== undefined) writeFileSync(join(srcDir, "AGENTS.aliases"), aliases);
  const destPath = join(cfg, "AGENTS.md");
  const manifestPath = join(state, ".manta", "opencode-guidance.manifest");
  if (dest !== undefined) writeFileSync(destPath, dest);
  if (manifest !== undefined) writeFileSync(manifestPath, manifest);
  const results = [];
  for (let i = 0; i < runs; i++) {
    const script = `set -euo pipefail
${HELPERS}
${i === 0 ? shadow : ""}
source '${RELEASE_LIB}'
export MANTA_STATE_HOME='${state}'
sync_opencode_guidance '${join(srcDir, "AGENTS.md")}' '${destPath}'
echo finished
`;
    results.push(bash(script));
    if (afterHook && i === 0) afterHook({ destPath, manifestPath, srcDir });
  }
  const last = results[results.length - 1];
  return {
    ...last,
    results,
    dest: existsSync(destPath) ? readFileSync(destPath, "utf8") : null,
    manifest: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
    destPath,
    manifestPath,
    root,
  };
}

const PRE = "# my notes\n\nhello\n";
const A_OLD = sec("## A", "old text of A");
const A_NEW = sec("## A", "new text of A");
const B = sec("## B", "text of B");
const C = sec("## C", "user's own section C");

describe("parser contract (JS)", () => {
  test("fenced `## ` is not a section; `###` is body; preamble belongs to nobody", () => {
    const text = "pre\n\n## One\n\n```\n## not a heading\n```\n\n### sub\n\ntext\n\n## Two\n\nx\n";
    const s = parseSections(text);
    assert.deepEqual(s.map((x) => x.heading), ["## One", "## Two"]);
    assert.match(s[0].canonical, /## not a heading/);
    assert.match(s[0].canonical, /### sub/);
    assert.doesNotMatch(s[0].canonical, /^pre/);
  });

  test("four-backtick fence containing a three-backtick block and a `## ` line is one section", () => {
    const text = "## One\n\n````md\n```\n## inner\n```\n## still inner\n````\n\n## Two\n\nx\n";
    assert.deepEqual(parseSections(text).map((x) => x.heading), ["## One", "## Two"]);
  });

  test("a closing fence with trailing text is not a close; an unclosed fence runs to EOF", () => {
    const text = "## One\n\n```\nbody\n``` not a close\n## swallowed\n";
    assert.deepEqual(parseSections(text).map((x) => x.heading), ["## One"]);
  });

  test("a different-character or shorter fence run inside a fence is body", () => {
    const text = "## One\n\n~~~~\n```\n~~~\n## swallowed\n~~~~\n## Two\n";
    assert.deepEqual(parseSections(text).map((x) => x.heading), ["## One", "## Two"]);
  });

  test("canonical bytes: CR stripped, trailing blank/whitespace-only lines dropped, one final newline", () => {
    const a = parseSections("## H\r\nline\r\n\r\n   \r\n\r\n")[0];
    const b = parseSections("## H\nline")[0];
    assert.equal(a.canonical, "## H\nline\n");
    assert.equal(a.hash, b.hash);
  });
});

describe("cross-language hash parity (bash _guidance_split vs guidance-history.mjs)", () => {
  const fixtures = {
    plain: "pre\n\n## A\n\nbody\n\n## B\n\nbody b\n",
    crlf: "## A\r\n\r\nbody\r\n\r\n## B\r\nx\r\n",
    noFinalNewline: "## A\n\nbody\n\n## B\n\nlast line no newline",
    trailingWhitespaceLines: "## A\n\nbody\n   \n\t\n\n## B\n\nx\n  \n",
    fences:
      "## A\n\n````md\n```\n## inner\n```\n````\n\n~~~\n## tilde inner\n~~~\n\n## B\n\n```\nunclosed\n## swallowed\n",
    trailingCloseText: "## A\n\n```\n``` nope\n## swallowed\n",
    subHeadings: "## A\n\n### sub\n\n#### subsub\n\n## B\n",
    unicode: "## manta on-call — `send_to_cto` (BET-1165)\n\nçà ü\n\n## Z\n",
    indentedFence: "## A\n\n   ```\n## inner\n   ```\n\n## B\n\n    ```\n## real\n",
    headingTrailingSpace: "## A   \n\nbody\n\n## B\t\n\nx\n",
  };
  for (const [name, text] of Object.entries(fixtures)) {
    test(`bash and JS agree: ${name}`, () => {
      const dir = tmp();
      const file = join(dir, "f.md");
      writeFileSync(file, text);
      const r = bash(`set -euo pipefail
${HELPERS}
source '${RELEASE_LIB}'
_guidance_split '${file}' '${dir}/p' > '${dir}/idx'
_guidance_hash_index '${dir}/idx' '${dir}/p' '${dir}/hidx'
cat '${dir}/hidx'`);
      assert.equal(r.status, 0, r.out);
      const bashRows = r.stdout.split("\n").filter(Boolean).map((l) => {
        const [, , , heading, hash] = l.split("\t");
        return `${heading}\t${hash}`;
      });
      assert.deepEqual(bashRows, historyLines(text));
    });
  }

  test("the real current guidance file hashes identically in bash and JS", () => {
    const file = join(REPO, "docs/opencode-tools/AGENTS.md");
    const dir = tmp();
    const r = bash(`set -euo pipefail
${HELPERS}
source '${RELEASE_LIB}'
_guidance_split '${file}' '${dir}/p' > '${dir}/idx'
_guidance_hash_index '${dir}/idx' '${dir}/p' '${dir}/hidx'
cut -f4,5 '${dir}/hidx'`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split("\n").filter(Boolean), historyLines(readFileSync(file, "utf8")));
  });
});

describe("sync rules", () => {
  test("appends missing sections, blank-line separated, preamble and user sections untouched", () => {
    const r = scenario({ src: join2(A_NEW, B), dest: PRE });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.dest, join2(PRE, A_NEW, B));
    assert.match(r.out, /2 added/);
  });

  test("a missing final newline in dest is added before appending", () => {
    const r = scenario({ src: A_NEW, dest: "# notes\n\nno newline" });
    assert.equal(r.dest, `# notes\n\nno newline\n\n${A_NEW}`);
  });

  test("creates dest (and its directory) when it does not exist", () => {
    const r = scenario({ src: join2(A_NEW, B), dest: undefined });
    assert.equal(r.dest, join2(A_NEW, B));
  });

  test("identical section: dest bytes unchanged, section recorded in the manifest", () => {
    const dest = join2(PRE, A_NEW, C);
    const r = scenario({ src: A_NEW, dest });
    assert.equal(r.dest, dest);
    assert.equal(r.manifest, `## A\t${hashOf(A_NEW)}\n`);
    assert.match(r.out, /already current/);
  });

  test("history-pristine section is replaced in place; neighbours byte-identical", () => {
    const dest = join2(PRE, A_OLD, B, C);
    const r = scenario({ src: join2(A_NEW, B), dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.dest, join2(PRE, A_NEW, B, C));
    assert.match(r.manifest, new RegExp(`## A\\t${hashOf(A_NEW)}`));
    assert.match(r.out, /1 refreshed/);
  });

  test("manifest-pristine section (no history) is replaced", () => {
    const dest = join2(PRE, A_OLD, B);
    const r = scenario({ src: A_NEW, dest, manifest: `## A\t${hashOf(A_OLD)}\n` });
    assert.equal(r.dest, join2(PRE, A_NEW, B));
    assert.equal(r.manifest, `## A\t${hashOf(A_NEW)}\n`);
  });

  test("edited section is left alone, with a warning, and not recorded", () => {
    const edited = sec("## A", "my own wording");
    const dest = join2(PRE, edited, B);
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, dest);
    assert.match(r.stderr, /you edited "## A"/);
    assert.ok(r.manifest === null || !r.manifest.includes("## A"));
  });

  test("duplicate heading in dest: left alone with an 'ambiguous' warning, nothing appended", () => {
    const dest = join2(A_OLD, B, A_OLD);
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, dest);
    assert.match(r.stderr, /more than once/);
  });

  test("duplicate heading in the shipped file is skipped entirely (others still sync)", () => {
    const dest = join2(PRE, A_OLD);
    const r = scenario({ src: join2(A_NEW, B, sec("## A", "second A")), dest, history: hist(["## A", A_OLD]) });
    assert.match(r.stderr, /repeats the heading "## A"/);
    assert.equal(r.dest, join2(PRE, A_OLD, B));
  });

  test("a section Manta never shipped (not in src, history or aliases) is never touched", () => {
    const dest = join2(PRE, C, A_OLD);
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, join2(PRE, C, A_NEW));
  });

  test("second run is a no-op", () => {
    const r = scenario({ src: join2(A_NEW, B), dest: join2(PRE, A_OLD, C), history: hist(["## A", A_OLD]), runs: 2 });
    assert.equal(r.results[0].status, 0);
    assert.match(r.results[0].out, /updated/);
    assert.match(r.results[1].out, /already current/);
    assert.equal(r.dest, join2(PRE, A_NEW, C, B));
    // a third run still changes nothing
    const again = readFileSync(r.manifestPath, "utf8");
    assert.equal(again, r.manifest);
  });

  test("failure before the guidance rename leaves dest and manifest untouched and returns 0", () => {
    const dest = join2(PRE, A_OLD);
    const r = scenario({
      src: A_NEW,
      dest,
      history: hist(["## A", A_OLD]),
      shadow: `mv() { case "$*" in *cfg/AGENTS.md) return 1 ;; esac; command mv "$@"; }`,
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /finished/);
    assert.equal(r.dest, dest);
    assert.equal(r.manifest, null);
    assert.match(r.stderr, /left unchanged/);
    const stray = spawnSync("bash", ["-c", `ls -A '${dirname(r.destPath)}'`], { encoding: "utf8" }).stdout;
    assert.equal(stray.trim(), "AGENTS.md", "no staged temp file left behind");
  });

  test("unwritable destination directory: dest unchanged, returns 0 (skipped when running as root)", (t) => {
    if (process.getuid && process.getuid() === 0) return t.skip("root ignores directory permissions");
    const dest = join2(PRE, A_OLD);
    const locked = tmp();
    const cfg = join(locked, "cfg");
    const srcDir = join(locked, "src");
    mkdirSync(cfg);
    mkdirSync(srcDir);
    writeFileSync(join(cfg, "AGENTS.md"), dest);
    writeFileSync(join(srcDir, "AGENTS.md"), A_NEW);
    writeFileSync(join(srcDir, "AGENTS.history"), hist(["## A", A_OLD]));
    spawnSync("chmod", ["555", cfg]);
    try {
      const run = bash(`set -euo pipefail
${HELPERS}
source '${RELEASE_LIB}'
export MANTA_STATE_HOME='${join(locked, "state")}'
sync_opencode_guidance '${join(srcDir, "AGENTS.md")}' '${join(cfg, "AGENTS.md")}'
echo finished`);
      assert.equal(run.status, 0, run.out);
      assert.match(run.stdout, /finished/);
      assert.match(run.stderr, /left unchanged/);
      assert.equal(readFileSync(join(cfg, "AGENTS.md"), "utf8"), dest);
    } finally {
      spawnSync("chmod", ["755", cfg]);
    }
  });

  test("failure between the two commits: guidance updated, old manifest kept, returns 0, next run is a no-op", () => {
    const oldManifest = `## B\t${"0".repeat(64)}\n`;
    const dest = join2(PRE, A_OLD);
    const root = scenario({
      src: A_NEW,
      dest,
      history: hist(["## A", A_OLD]),
      manifest: oldManifest,
      shadow: `mv() { case "$*" in *opencode-guidance.manifest) return 1 ;; esac; command mv "$@"; }`,
    });
    assert.equal(root.status, 0, root.out);
    assert.match(root.stdout, /finished/);
    assert.equal(root.dest, join2(PRE, A_NEW), "guidance was committed");
    assert.equal(root.manifest, oldManifest, "previous manifest kept");
    assert.match(root.stderr, /could not record/);
    // Next run (mv healthy): the new section is pristine (its hash is the shipped one) → no-op.
    const second = bash(`set -euo pipefail
${HELPERS}
source '${RELEASE_LIB}'
export MANTA_STATE_HOME='${join(root.root, "state")}'
sync_opencode_guidance '${join(root.root, "src", "AGENTS.md")}' '${root.destPath}'`);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /already current/);
    assert.equal(readFileSync(root.destPath, "utf8"), join2(PRE, A_NEW));
    assert.match(readFileSync(root.manifestPath, "utf8"), new RegExp(`## A\\t${hashOf(A_NEW)}`));
  });

  test("CRLF dest: pristine section recognised and replaced; untouched lines keep their CRLF", () => {
    const crlf = (s) => s.replace(/\n/g, "\r\n");
    const dest = crlf(join2(PRE, A_OLD)) + crlf("\n" + C);
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, crlf(PRE) + "\r\n" + A_NEW + "\n" + crlf(C));
  });

  test("dest without a final newline: untouched last line stays unterminated when a middle section is replaced", () => {
    const tail = "## C\n\nlast line, no newline";
    const dest = join2(A_OLD, B) + "\n" + tail;
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, join2(A_NEW, B) + "\n" + tail);
  });

  test("whitespace-only trailing lines in dest do not make a pristine section look edited", () => {
    const dest = join2(PRE, A_OLD.trimEnd() + "\n   \n\t\n", B);
    const r = scenario({ src: A_NEW, dest, history: hist(["## A", A_OLD]) });
    assert.equal(r.dest, join2(PRE, A_NEW, B));
  });

  test("a fenced `## ` inside a shipped section does not split it", () => {
    const fenced = "## F\n\n```md\n## inside fence\n```\n\nafter\n";
    const r = scenario({ src: fenced, dest: PRE });
    assert.equal(r.dest, join2(PRE, fenced));
    assert.equal(r.manifest, `## F\t${hashOf(fenced)}\n`);
  });

  test("manifest lands under MANTA_STATE_HOME; whitespace-only counts as unset (falls back to $HOME)", () => {
    const home = tmp();
    const d = tmp();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "AGENTS.md"), A_NEW);
    const r = bash(`set -euo pipefail
${HELPERS}
source '${RELEASE_LIB}'
HOME='${home}'
export MANTA_STATE_HOME='   '
sync_opencode_guidance '${join(d, "src", "AGENTS.md")}' '${join(d, "AGENTS.md")}'`);
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(home, ".manta", "opencode-guidance.manifest")));
  });
});

describe("aliases (renames)", () => {
  const O1 = sec("## OLD1", "first old");
  const O2 = sec("## OLD2", "second old");
  const NEW = sec("## NEW", "renamed and revised");
  const aliasFile = (...pairs) => pairs.map(([a, b]) => `${a}\t${b}`).join("\n") + "\n";

  test("pristine predecessor is replaced in place under the new heading", () => {
    const dest = join2(PRE, B, O1, C);
    const r = scenario({
      src: NEW,
      dest,
      history: hist(["## OLD1", O1]),
      aliases: aliasFile(["## OLD1", "## NEW"]),
    });
    assert.equal(r.dest, join2(PRE, B, NEW, C));
  });

  test("edited predecessor: nothing changes, nothing appended, warning names it", () => {
    const edited = sec("## OLD1", "I changed this");
    const dest = join2(PRE, edited);
    const r = scenario({ src: NEW, dest, history: hist(["## OLD1", O1]), aliases: aliasFile(["## OLD1", "## NEW"]) });
    assert.equal(r.dest, dest);
    assert.match(r.stderr, /"## OLD1"/);
  });

  test("current heading present AND a pristine predecessor: the predecessor is removed", () => {
    const dest = join2(PRE, O1, NEW, C);
    const r = scenario({ src: NEW, dest, history: hist(["## OLD1", O1]), aliases: aliasFile(["## OLD1", "## NEW"]) });
    assert.equal(r.dest, join2(PRE, NEW, C));
    assert.match(r.out, /1 stale removed/);
  });

  test("current heading present, predecessor edited: predecessor kept with a warning", () => {
    const edited = sec("## OLD1", "I changed this");
    const dest = join2(PRE, edited, NEW);
    const r = scenario({ src: NEW, dest, history: hist(["## OLD1", O1]), aliases: aliasFile(["## OLD1", "## NEW"]) });
    assert.equal(r.dest, dest);
    assert.match(r.stderr, /left in place/);
  });

  for (const order of ["forward", "reversed"]) {
    test(`two pristine predecessors (${order} alias order): first in dest order replaced, other deleted`, () => {
      const dest = join2(PRE, O1, B, O2, C);
      const pairs = [["## OLD1", "## NEW"], ["## OLD2", "## NEW"]];
      if (order === "reversed") pairs.reverse();
      const r = scenario({
        src: NEW,
        dest,
        history: hist(["## OLD1", O1], ["## OLD2", O2]),
        aliases: aliasFile(...pairs),
      });
      assert.equal(r.dest, join2(PRE, NEW, B, C));
    });

    test(`pristine + edited predecessor (${order} alias order): nothing changes`, () => {
      const edited = sec("## OLD2", "edited by the user");
      const dest = join2(PRE, O1, B, edited);
      const pairs = [["## OLD1", "## NEW"], ["## OLD2", "## NEW"]];
      if (order === "reversed") pairs.reverse();
      const r = scenario({
        src: NEW,
        dest,
        history: hist(["## OLD1", O1], ["## OLD2", O2]),
        aliases: aliasFile(...pairs),
      });
      assert.equal(r.dest, dest);
      assert.match(r.stderr, /"## OLD2"/);
    });
  }

  test("an alias whose old heading is itself shipped is ignored", () => {
    const dest = join2(PRE, B);
    const r = scenario({ src: join2(NEW, B), dest, history: hist(["## B", B]), aliases: aliasFile(["## B", "## NEW"]) });
    assert.equal(r.dest, join2(PRE, B, NEW));
  });
});

describe("history freshness", () => {
  test("every section of the current guidance file is in AGENTS.history (run `node scripts/release/guidance-history.mjs`)", () => {
    const current = historyLines(readFileSync(join(REPO, "docs/opencode-tools/AGENTS.md"), "utf8"));
    const history = new Set(readFileSync(join(REPO, "docs/opencode-tools/AGENTS.history"), "utf8").split("\n"));
    const missing = current.filter((l) => !history.has(l));
    assert.deepEqual(
      missing.map((l) => l.split("\t")[0]),
      [],
      "docs/opencode-tools/AGENTS.md changed without regenerating AGENTS.history — run `node scripts/release/guidance-history.mjs` and commit the result",
    );
  });

  test("AGENTS.history is sorted and unique", () => {
    const lines = readFileSync(join(REPO, "docs/opencode-tools/AGENTS.history"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(lines, [...new Set(lines)].sort());
    for (const l of lines) assert.match(l, /^## .+\t[0-9a-f]{64}$/);
  });

  test("mergeHistory never drops a line", () => {
    const existing = ["## Gone\t" + "a".repeat(64), "## Keep\t" + "b".repeat(64)];
    const merged = mergeHistory(existing, ["## Keep\t" + "b".repeat(64), "## New\t" + "c".repeat(64)]);
    for (const l of existing) assert.ok(merged.includes(l));
    assert.deepEqual(merged, [...new Set(merged)].sort());
  });

  test("regenerating over the committed file removes nothing (full clones only)", (t) => {
    const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" });
    if (shallow.status !== 0 || shallow.stdout.trim() !== "false") return t.skip("needs full git history");
    const r = generate({ root: REPO, write: false });
    const committed = readFileSync(join(REPO, "docs/opencode-tools/AGENTS.history"), "utf8").split("\n").filter(Boolean);
    for (const l of committed) assert.ok(r.merged.includes(l), `regeneration dropped: ${l}`);
  });

  test("every heading that disappeared from history is either aliased or deliberately removed", () => {
    // The only removed section with no successor is the retired ios_build tool.
    const aliases = readFileSync(join(REPO, "docs/opencode-tools/AGENTS.aliases"), "utf8").split("\n").filter(Boolean);
    const current = new Set(parseSections(readFileSync(join(REPO, "docs/opencode-tools/AGENTS.md"), "utf8")).map((s) => s.heading));
    for (const l of aliases) {
      const [oldH, newH] = l.split("\t");
      assert.ok(oldH && newH, `bad alias line: ${l}`);
      assert.ok(current.has(newH), `alias target is not a current heading: ${newH}`);
      assert.ok(!current.has(oldH), `alias source is still a current heading: ${oldH}`);
    }
  });
});

describe("lifecycle (behavioural): the new sync actually runs on update/install", () => {
  // The function as it was on origin/main before this change: append-only.
  const OLD_LIB = `
sync_opencode_guidance() {
  local src="$1" dest="$2" tmp changed=0 section="" heading="" line
  tmp="$(mktemp "\${TMPDIR:-/tmp}/manta-agents.XXXXXX")"
  [ -f "$dest" ] && cat "$dest" > "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '##'*)
        if [ -n "$section" ] && ! grep -qFx -- "$heading" "$dest" 2>/dev/null; then
          [ -s "$tmp" ] && printf '\\n' >> "$tmp"; printf '%s' "$section" >> "$tmp"; changed=1
        fi
        heading="$line"; section="$line
" ;;
      *) section="\${section}\${line}
" ;;
    esac
  done < "$src"
  if [ -n "$section" ] && ! grep -qFx -- "$heading" "$dest" 2>/dev/null; then
    [ -s "$tmp" ] && printf '\\n' >> "$tmp"; printf '%s' "$section" >> "$tmp"; changed=1
  fi
  if [ "$changed" = "1" ]; then mv "$tmp" "$dest"; ok "OLD sync appended"; else rm -f "$tmp"; ok "OLD sync: current"; fi
}
`;

  function payload(root, { lib = RELEASE_LIB } = {}) {
    const home = join(root, "home");
    mkdirSync(join(home, "scripts", "lib"), { recursive: true });
    mkdirSync(join(home, "docs", "opencode-tools"), { recursive: true });
    copyFileSync(lib, join(home, "scripts", "lib", "release.sh"));
    writeFileSync(join(home, "docs", "opencode-tools", "AGENTS.md"), join2(A_NEW, B));
    writeFileSync(join(home, "docs", "opencode-tools", "AGENTS.history"), hist(["## A", A_OLD]));
    return home;
  }

  const selfUpdate = readFileSync(join(HERE, "..", "self-update.sh"), "utf8");
  const installSh = readFileSync(join(HERE, "..", "install.sh"), "utf8");
  const resourceBlock = selfUpdate.match(/if \[ "\$PAYLOAD_REPLACED" = "1" \] && \[ -f "\$MANTA_HOME\/scripts\/lib\/release\.sh" \]; then\n[\s\S]*?\nfi\n/);
  const syncCall = selfUpdate.match(/^sync_opencode_guidance "\$MANTA_HOME\/docs\/opencode-tools\/AGENTS\.md".*$/m);
  const installBlock = installSh.match(/ {2}if \[ -f "\$OPENCODE_TOOLS_SRC\/AGENTS\.md" \]; then\n[\s\S]*?\n {2}fi\n/);

  test("harness extracted the real self-update.sh and install.sh snippets", () => {
    assert.ok(resourceBlock, "self-update.sh re-source block not found");
    assert.ok(syncCall, "self-update.sh sync call not found");
    assert.ok(installBlock, "install.sh guidance block not found");
  });

  test("self-update.sh re-sources the lib AFTER the payload swap and BEFORE the guidance sync", () => {
    const swap = selfUpdate.indexOf("replace_release_payload ");
    const resource = selfUpdate.indexOf('if [ "$PAYLOAD_REPLACED" = "1" ] && [ -f "$MANTA_HOME/scripts/lib/release.sh" ]');
    const call = selfUpdate.indexOf('sync_opencode_guidance "$MANTA_HOME/docs/opencode-tools/AGENTS.md"');
    assert.ok(swap > 0 && resource > swap && call > resource);
  });

  test("install.sh sources the lib from the extracted payload before calling the guidance sync", () => {
    assert.ok(installBlock[0].indexOf('. "$MANTA_HOME/scripts/lib/release.sh"') < installBlock[0].indexOf('sync_opencode_guidance "$OPENCODE_TOOLS_SRC'));
    assert.ok(!/sync_opencode_guidance\(\)/.test(installSh), "install.sh must not carry an inline copy of the sync");
  });

  function updateHarness(root, home, { payloadReplaced }) {
    const cfg = join(root, "cfg");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "AGENTS.md"), join2(PRE, A_OLD));
    // The "running" self-update.sh sourced the OLD lib before the swap: simulate with the OLD function,
    // then the swap puts the NEW lib on disk (payload()), then the script's own re-source block runs.
    const oldLib = join(root, "old-lib.sh");
    writeFileSync(oldLib, OLD_LIB);
    const script = `set -euo pipefail
${HELPERS}
MANTA_HOME='${home}'
export MANTA_STATE_HOME='${join(root, "state")}'
export OPENCODE_CONFIG_DIR='${cfg}'
. '${oldLib}'
PAYLOAD_REPLACED=${payloadReplaced ? 1 : 0}
${resourceBlock[0]}
${syncCall[0]}
echo finished`;
    const r = bash(script);
    return { ...r, dest: readFileSync(join(cfg, "AGENTS.md"), "utf8") };
  }

  test("(a) update: OLD in-memory lib + payload swap + the real re-source block → the NEW sync runs", () => {
    const root = tmp();
    const home = payload(root);
    const r = updateHarness(root, home, { payloadReplaced: true });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /finished/);
    assert.equal(r.dest, join2(PRE, A_NEW, B), "stale section refreshed in place and missing one appended");
    assert.doesNotMatch(r.out, /OLD sync/);
  });

  test("(a) control: without the re-source the OLD function runs and the stale section stays (proves the harness discriminates)", () => {
    const root = tmp();
    const home = payload(root);
    const r = updateHarness(root, home, { payloadReplaced: false });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /OLD sync appended/);
    assert.ok(r.dest.includes("old text of A"), "old behaviour leaves the stale section in place");
  });

  test("(b) piped install: no lib sourced up front → the guidance block sources the payload lib and the NEW sync runs", () => {
    const root = tmp();
    const home = payload(root);
    const cfg = join(root, "cfg");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "AGENTS.md"), join2(PRE, A_OLD));
    const script = `set -euo pipefail
${HELPERS}
MANTA_HOME='${home}'
export MANTA_STATE_HOME='${join(root, "state")}'
OPENCODE_TOOLS_SRC="$MANTA_HOME/docs/opencode-tools"
OPENCODE_AGENTS='${join(cfg, "AGENTS.md")}'
! declare -F sync_opencode_guidance >/dev/null 2>&1
${installBlock[0]}
echo finished`;
    const r = bash(script);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /finished/);
    assert.equal(readFileSync(join(cfg, "AGENTS.md"), "utf8"), join2(PRE, A_NEW, B));
  });
});
