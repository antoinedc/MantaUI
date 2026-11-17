import { test } from "node:test";
import assert from "node:assert/strict";
import { getSection, isSafePagePath, listSections, pageArea, pageTitle, parsePage, renderPage, spliceSection, summarizeBody, updateFrontMatter } from "./pages.mjs";

const SRC = `---
title: Release and rollback
verified: 2026-11-16
sources: [commit:c4bbd906, "msg:ses_1/msg_2"]
---
# Release

## Briefing

old line one
old line two

\`\`\`sh
## not a heading
npm run release
\`\`\`

## Other   

keep   this  exactly
  indented
`;

test("front matter parses (dates stay strings) and the body offset is exact", () => {
  const p = parsePage(SRC);
  assert.equal(p.frontMatter.title, "Release and rollback");
  assert.equal(p.frontMatter.verified, "2026-11-16");
  assert.deepEqual(p.frontMatter.sources, ["commit:c4bbd906", "msg:ses_1/msg_2"]);
  assert.equal(SRC.slice(p.bodyOffset), p.body);
  assert.ok(p.body.startsWith("# Release"));
});

test("no fence / broken YAML → body is the whole source", () => {
  assert.deepEqual(parsePage("# Hi\n").frontMatter, null);
  assert.equal(parsePage("# Hi\n").body, "# Hi\n");
  assert.equal(parsePage("---\n: : bad: [\n---\nbody\n").frontMatter, null);
});

test("splice replaces ONLY the section; formatting elsewhere is byte-identical; code-fence headings are not headings", () => {
  const out = spliceSection(SRC, "Briefing", "new line");
  assert.ok(out.includes("## Briefing\n\nnew line\n\n## Other   \n\nkeep   this  exactly\n  indented\n"));
  assert.ok(out.startsWith(SRC.slice(0, SRC.indexOf("## Briefing"))));
  assert.ok(!out.includes("old line"));
  assert.ok(!out.includes("npm run release")); // the fence belonged to the Briefing section
  assert.deepEqual(listSections(SRC).map((s) => s.text), ["Release", "Briefing", "Other"]);
});

test("a heading inside a code fence is never matched", () => {
  assert.equal(getSection(SRC, "not a heading"), null);
});

test("append mode adds to the section; a missing section is created at the end", () => {
  const appended = spliceSection(SRC, "Other", "- more", { mode: "append" });
  assert.ok(appended.endsWith("keep   this  exactly\n  indented\n- more\n"));
  const created = spliceSection(SRC, "Gotchas", "text");
  assert.ok(created.endsWith("  indented\n\n## Gotchas\n\ntext\n"));
  assert.equal(getSection(created, "Gotchas").trim(), "text");
});

test("a page without front matter splices without inventing one", () => {
  const out = spliceSection("# T\n\n## A\n\nx\n", "A", "y");
  assert.equal(out, "# T\n\n## A\n\ny\n");
});

test("updateFrontMatter changes keys and keeps the body", () => {
  const out = updateFrontMatter(SRC, { verified: "2026-12-01" });
  const p = parsePage(out);
  assert.equal(p.frontMatter.verified, "2026-12-01");
  assert.equal(p.frontMatter.title, "Release and rollback");
  assert.equal(p.body, parsePage(SRC).body);
  assert.equal(renderPage({ frontMatter: {}, body: "x" }), "x");
});

test("page paths: only user/, commons/, projects/<slug>/ markdown; no traversal or dotfiles", () => {
  assert.equal(isSafePagePath("user/preferences.md"), true);
  assert.equal(isSafePagePath("commons/howto/deploy.md"), true);
  assert.equal(isSafePagePath("projects/widget-0123456789/runbooks/x.md"), true);
  for (const bad of ["../x.md", "user/../../x.md", "/etc/passwd", "projects/x/y.md", "user/.hidden.md", "user/a.txt", "projects.json", "user\\a.md", ""]) assert.equal(isSafePagePath(bad), false, bad);
  assert.deepEqual(pageArea("projects/widget-0123456789/a.md"), { area: "project", slug: "widget-0123456789" });
  assert.deepEqual(pageArea("commons/a.md"), { area: "commons", slug: null });
  assert.equal(pageArea("nope.md"), null);
});

test("title and summary helpers", () => {
  assert.equal(pageTitle(SRC, "x/y.md"), "Release and rollback");
  assert.equal(pageTitle("# From heading\n", "x/y.md"), "From heading");
  assert.equal(pageTitle("text", "x/deploy-notes.md"), "deploy-notes");
  assert.equal(summarizeBody("# H\n\n- first **thing** here\nsecond"), "first thing here");
  assert.equal(summarizeBody("a".repeat(200), 20).length, 20);
});

test("front matter that doesn't parse is never duplicated: edits leave it exactly where it is", () => {
  const broken = "---\ntitle: [unclosed\nverified: 2026-01-01\n---\n# Page\n\n## Notes\n\nold\n";
  const p = parsePage(broken);
  assert.equal(p.invalid, true);
  assert.equal(p.frontMatter, null);
  assert.equal(p.body, "# Page\n\n## Notes\n\nold\n");
  assert.equal(updateFrontMatter(broken, { verified: "2026-11-17" }), broken);
  const edited = spliceSection(broken, "Notes", "new");
  assert.equal(edited.match(/^---$/gm).length, 2, "one front matter block, not two");
  assert.match(edited, /^---\ntitle: \[unclosed/);
  assert.match(edited, /## Notes\n\nnew\n$/);
});
