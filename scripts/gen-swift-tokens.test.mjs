import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, run } from "./gen-swift-tokens.mjs";

// A minimal tokens.css covering every token the generator requires, for both
// themes AND the :root metrics block. Real `src/renderer/tokens.css` is never
// touched by these tests.
const VARIABLES = [
  "canvas", "panel", "card", "raised", "inset",
  "border-subtle", "border", "border-strong",
  "tx1", "tx2", "tx3", "tx4",
  "accent", "accent-tx", "accent-solid", "on-accent", "accent-soft",
  "ok", "warn", "danger", "info",
  "fill", "fill-active",
];

// :root metric/typography tokens the generator emits into the Metrics enum.
const ROOT_VARIABLES = [
  ["sp-0", "0"], ["sp-px", "1px"], ["sp-1", "4px"], ["sp-2", "8px"],
  ["sp-3", "12px"], ["sp-4", "16px"], ["sp-5", "20px"], ["sp-6", "24px"],
  ["sp-8", "32px"], ["sp-10", "40px"], ["sp-12", "48px"],
  ["r-xs", "4px"], ["r-sm", "6px"], ["r-md", "8px"], ["r-lg", "12px"],
  ["r-xl", "16px"], ["r-full", "999px"],
  ["font-sans", '"Inter Variable"'], ["font-mono", '"JetBrains Mono Variable"'],
  ["font-size-body", "15px"], ["font-size-small", "13px"],
  ["font-size-xs", "12px"], ["font-size-2xs", "11px"],
  // S2 onboarding display sizes (BET-594) — must track gen-swift-tokens.mjs
  // TYPE_MAP so the widened generator's lookups resolve in the test fixture.
  ["font-size-display", "28px"], ["font-size-confirm", "40px"], ["font-size-otp", "26px"],
  ["weight-medium", "500"], ["weight-semibold", "600"],
  ["prose-lh", "1.55"], ["ui-lh", "1.45"],
  ["step-row-y", "7px"], ["step-dot", "6px"],
  // §7 session-list metrics (BET-595) — must track gen-swift-tokens.mjs
  // TYPE_MAP/LAYOUT_MAP so the widened generator's lookups resolve in the
  // test fixture.
  ["font-size-row-name", "15.5px"],
  ["tracking-list-heading", "-0.015"], ["tracking-row-name", "-0.01"],
  ["list-row-min-h", "62px"], ["list-row-radius", "20px"],
  ["list-row-margin", "2px"],
  ["list-group-above", "22px"], ["list-group-below", "6px"],
  // §8 chat-screen header metrics (BET-596) — must track gen-swift-tokens.mjs
  // TYPE_MAP/LAYOUT_MAP so the widened generator's lookups resolve in the
  // test fixture.
  ["font-size-chat-title", "14.5px"], ["tracking-chat-title", "-0.01"],
  ["chat-header-btn", "38px"],
];

function cssFor(prefix) {
  const vars = VARIABLES.map((v) => `  --${v}: ${prefix}-${v};`).join("\n");
  const root = ROOT_VARIABLES.map(([k, v]) => `  --${k}: ${v};`).join("\n");
  return (
    `:root {\n${root}\n}\n\n` +
    `[data-theme="light"] {\n${vars}\n}\n\n[data-theme="dark"] {\n${vars}\n}\n`
  );
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
