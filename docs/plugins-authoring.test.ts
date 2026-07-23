// docs/plugins-authoring.md — shape guard.
//
// The agent-facing authoring guide has eight required sections, in order.
// A user (or an AI tool) that reads it relies on those sections existing
// where the doc promises them. This test reads the file from the repo
// and asserts the section headers appear in order, plus the three worked
// examples exist as fenced ``` blocks.
//
// Failure here means the doc was edited in a way that breaks the
// agent-authoring contract (and breaks plugin_docs() in
// docs/opencode-tools/plugins.ts). Fix the doc, not the test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(__dirname, "plugins-authoring.md");

const REQUIRED_SECTIONS = [
  "## 1. What a plugin is + where it lives",
  "## 2. Full schema reference",
  "## 3. The input / env-var rule — never interpolate inputs into commands",
  "## 4. `if:` grammar — exactly three forms, nothing else",
  "## 5. Worked examples",
  "## 6. Error catalogue",
  "## 7. The author / test loop",
  "## 8. Operational facts",
];

const REQUIRED_EXAMPLE_HEADINGS = [
  "### 5.1. iOS app via Capacitor (MantaUI's own flow)",
  "### 5.2. Plain Xcode app (no Capacitor)",
  "### 5.3. Generic script plugin",
];

describe("docs/plugins-authoring.md", () => {
  const doc = readFileSync(DOC_PATH, "utf-8");

  it("exists and is non-empty", () => {
    expect(doc.length).toBeGreaterThan(1000);
  });

  it("contains all eight required top-level sections, in order", () => {
    let cursor = 0;
    for (const heading of REQUIRED_SECTIONS) {
      const idx = doc.indexOf(heading, cursor);
      expect(idx, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
      expect(idx, `section out of order: ${heading}`).toBeGreaterThanOrEqual(cursor);
      cursor = idx + heading.length;
    }
  });

  it("contains all three worked-example sub-sections in §5, in order", () => {
    let cursor = doc.indexOf("## 5. Worked examples");
    expect(cursor).toBeGreaterThanOrEqual(0);
    for (const heading of REQUIRED_EXAMPLE_HEADINGS) {
      const idx = doc.indexOf(heading, cursor);
      expect(idx, `missing example: ${heading}`).toBeGreaterThanOrEqual(0);
      cursor = idx + heading.length;
    }
  });

  it("ships three worked examples as fenced code blocks (the YAML manifests)", () => {
    const yamlFenceCount = (doc.match(/```yaml\b/g) ?? []).length;
    expect(yamlFenceCount).toBeGreaterThanOrEqual(3);
  });
});
