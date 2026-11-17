import { test } from "node:test";
import assert from "node:assert/strict";
import {
  START_MARKER,
  END_MARKER,
  BLOCK_BUDGET_LINES,
  sanitizeRule,
  renderBlock,
  findBlock,
  applyBlock,
  hashBlock,
  parseBlockRules,
  assertRepoSafe,
  repoTextViolations,
} from "./repoBlock.mjs";

test("sanitizeRule strips message/session refs, quotes, comments and markers", () => {
  assert.equal(sanitizeRule("Use pnpm, never npm (msg:ses_0123456789abcdef/msg_0123456789abcdef)"), "Use pnpm, never npm");
  assert.equal(sanitizeRule("> the user said: use tabs"), "the user said: use tabs");
  assert.equal(sanitizeRule("- Run tests first <!-- manta:knowledge:end --> then push"), "Run tests first then push");
  assert.equal(sanitizeRule("part:ses_abc123456/prt_abc123456"), null);
  assert.equal(sanitizeRule("   "), null);
  assert.equal(sanitizeRule("# Heading rule"), "Heading rule");
  assert.equal(sanitizeRule("Line one\nline two"), "Line one line two");
  assert.ok(sanitizeRule("x".repeat(500)).length <= 300);
});

test("sanitized output always passes the repo-safety assertion", () => {
  const hostile = ["see msg:ses_aaaaaaaa/msg_bbbbbbbb now", "ses_0123456789abcdef is the session", "> quoted\n> more", "file:/home/dev/x and page:projects/a/b.md", "note n_01HZZZZZZZZZZZZZZZZZZZZZZZ"];
  for (const h of hostile) {
    const s = sanitizeRule(h);
    if (s !== null) assert.doesNotThrow(() => assertRepoSafe(s), h);
  }
  assert.throws(() => assertRepoSafe("see msg:ses_abc/msg_def"));
  assert.throws(() => assertRepoSafe("> a quote"));
  assert.deepEqual(repoTextViolations("plain rule"), []);
});

test("renderBlock: markers, heading, one line per rule, dedupe, drops empties", () => {
  const r = renderBlock(["Use pnpm", "use pnpm", "msg:ses_aaaaaaaa/msg_bbbbbbbb", "Run lint before commit — keeps CI green"]);
  assert.equal(r.block.split("\n")[0], START_MARKER);
  assert.equal(r.block.split("\n").at(-1), END_MARKER);
  assert.deepEqual(parseBlockRules(r.block), ["Use pnpm", "Run lint before commit — keeps CI green"]);
  assert.equal(r.dropped.length, 1);
  assert.equal(renderBlock([]).block, null);
  assert.equal(renderBlock(["msg:ses_aaaaaaaa/msg_bbbbbbbb"]).block, null);
});

test("renderBlock enforces the 120-line budget and reports truncation", () => {
  const rules = Array.from({ length: 200 }, (_, i) => `Rule number ${i}`);
  const r = renderBlock(rules);
  assert.ok(r.block.split("\n").length <= BLOCK_BUDGET_LINES);
  assert.equal(r.block.split("\n").length, BLOCK_BUDGET_LINES);
  assert.equal(r.truncated, 200 - (BLOCK_BUDGET_LINES - 4));
  assert.equal(parseBlockRules(r.block)[0], "Rule number 0");
});

test("findBlock: none, found, corrupt variants", () => {
  assert.equal(findBlock("# Hi\n").status, "none");
  const b = renderBlock(["A"]).block;
  const f = findBlock(`# Hi\n\n${b}\n\ntail\n`);
  assert.equal(f.status, "found");
  assert.equal(f.text, b);
  assert.equal(findBlock(`${START_MARKER}\nA\n`).status, "corrupt");
  assert.equal(findBlock(`A\n${END_MARKER}\n`).status, "corrupt");
  assert.equal(findBlock(`${END_MARKER}\n${START_MARKER}\n`).status, "corrupt");
  assert.equal(findBlock(`${b}\n${b}\n`).status, "corrupt");
});

test("applyBlock appends, replaces in place, removes, and keeps the rest byte-for-byte", () => {
  const a = renderBlock(["A"]).block;
  const bb = renderBlock(["A", "B"]).block;
  const src = "# Project\n\nSome text.\n";
  const appended = applyBlock(src, a);
  assert.equal(appended, `${src}\n${a}\n`);
  const replaced = applyBlock(`${appended}\n## After\nmore\n`, bb);
  assert.ok(replaced.startsWith(src));
  assert.ok(replaced.endsWith("\n## After\nmore\n"));
  assert.deepEqual(parseBlockRules(findBlock(replaced).text), ["A", "B"]);
  assert.equal(applyBlock(appended, null), src);
  assert.equal(applyBlock(src, null), src);
  assert.equal(applyBlock("", a), `${a}\n`);
  assert.equal(applyBlock(applyBlock("", a), null), "");
  assert.throws(() => applyBlock(`${START_MARKER}\nA\n`, a), /damaged|can't be edited/);
});

test("applyBlock preserves CRLF files", () => {
  const out = applyBlock("# T\r\n\r\ntext\r\n", renderBlock(["A"]).block);
  assert.ok(out.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(out));
});

test("hashBlock is line-ending and edge-whitespace insensitive; null → null", () => {
  const b = renderBlock(["A"]).block;
  assert.equal(hashBlock(b), hashBlock(`${b.replace(/\n/g, "\r\n")}\n`));
  assert.notEqual(hashBlock(b), hashBlock(renderBlock(["B"]).block));
  assert.equal(hashBlock(null), null);
});
