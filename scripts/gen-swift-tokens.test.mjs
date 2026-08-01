import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, run } from "./gen-swift-tokens.mjs";

// A minimal tokens.css covering every token the generator requires, for both
// themes. Real `src/renderer/tokens.css` is never touched by these tests.
const VARIABLES = [
  "canvas", "panel", "card", "raised", "inset",
  "border-subtle", "border", "border-strong",
  "tx1", "tx2", "tx3", "tx4",
  "accent", "accent-tx", "accent-solid", "on-accent",
  "ok", "warn", "danger", "info",
  "fill", "fill-active",
];

function cssFor(prefix) {
  const vars = VARIABLES.map((v) => `  --${v}: ${prefix}-${v};`).join("\n");
  return `[data-theme="light"] {\n${vars}\n}\n\n[data-theme="dark"] {\n${vars}\n}\n`;
}

const SAMPLE_CSS = cssFor("#A");
const OTHER_CSS = cssFor("#B");
const SAMPLE_OUT = generate(SAMPLE_CSS);
const OTHER_OUT = generate(OTHER_CSS);

// Route reads between the css source and the generated file, and capture every
// write, so the tests never touch the real filesystem.
function harness({ committed, writeSpy = () => {} }) {
  const writes = [];
  const readFile = (p) => {
    if (p.endsWith("tokens.css")) return SAMPLE_CSS;
    if (committed instanceof Error) throw committed;
    return committed;
  };
  const writeFile = (p, data) => {
    writes.push({ p, data });
    writeSpy(p, data);
  };
  const logs = [];
  const log = (s) => logs.push(s);
  return { run: (opts) => run({ readFile, writeFile, log, ...opts }), writes, logs };
}

test("--check: identical input exits 0 and writes nothing", () => {
  const h = harness({ committed: SAMPLE_OUT });
  const code = h.run({ check: true });
  assert.equal(code, 0);
  assert.equal(h.writes.length, 0);
});

test("--check: differing input exits 1 and writes nothing", () => {
  const h = harness({ committed: OTHER_OUT });
  const code = h.run({ check: true });
  assert.equal(code, 1);
  assert.equal(h.writes.length, 0);
  assert.ok(
    h.logs.some((l) => l.includes("out of date")),
    "failure message includes the remedy",
  );
});

test("--check: missing generated file exits 1 and writes nothing", () => {
  const h = harness({ committed: new Error("ENOENT") });
  const code = h.run({ check: true });
  assert.equal(code, 1);
  assert.equal(h.writes.length, 0);
});

test("normal mode still writes when different (default not regressed)", () => {
  const h = harness({ committed: OTHER_OUT });
  const code = h.run({ check: false });
  assert.equal(code, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data, SAMPLE_OUT);
});

test("normal mode does not write when identical", () => {
  const h = harness({ committed: SAMPLE_OUT });
  const code = h.run({ check: false });
  assert.equal(code, 0);
  assert.equal(h.writes.length, 0);
});
