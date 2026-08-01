import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTokenMap, renderSectionA } from "./style-diff.mjs";

const MAP_CSS = `
:root {
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-a: 8px;
  --sp-b: 8px;
  --r-lg: 12px;
  --r-xl: 16px;
  --r-sm: 8px;
  --color-ink: #111111;
}
`;

const map = buildTokenMap(MAP_CSS);

function rec(props) {
  return { role: "x", ordinal: 1, props };
}

/** Render Section A for one app record (no mockup) and return the text. */
function render(props) {
  return renderSectionA([rec(props)], [], map);
}

test("border-radius value colliding with spacing+radius keeps only the radius token", () => {
  const out = render({ "border-radius": "12px" });
  assert.match(out, /--r-lg ×1/);
  assert.doesNotMatch(out, /--sp-3/);
});

test("padding value colliding with spacing+radius keeps only the spacing token", () => {
  const out = render({ "padding-top": "12px" });
  assert.match(out, /padding-\*[\s\S]*--sp-3 ×1/);
  assert.doesNotMatch(out, /--r-lg/);
});

test("gap value colliding with spacing+radius keeps only the spacing token", () => {
  const out = render({ gap: "16px" });
  assert.match(out, /gap[\s\S]*--sp-4 ×1/);
  assert.doesNotMatch(out, /--r-xl/);
});

test("a value whose family matches no token renders as NO match, not a filtered-empty bucket", () => {
  const out = render({ "font-size": "12px" });
  assert.equal(out, "No token-mapped styling on either side.");
});

test("two colliding tokens WITHIN the spacing family still bucket honestly", () => {
  const out = render({ "padding-top": "8px" });
  assert.match(out, /--sp-a\|--sp-b ×1/);
});

test("an unambiguous token (colour) is untouched by family filtering", () => {
  const out = render({ color: "#111111" });
  assert.match(out, /--color-ink ×1/);
});
