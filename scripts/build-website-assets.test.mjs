// scripts/build-website-assets.test.mjs
//
// Acceptance tests for the GEO-layer build scripts (BET-300). These tests
// run via `npm test` (`scripts/*.test.mjs`).
//
// What they pin:
//   - build-website-schema.mjs is idempotent: re-running on identical input
//     produces byte-identical HTML files.
//   - build-website-sitemap.mjs is idempotent: re-running produces
//     byte-identical sitemap.xml.
//   - build-llms-full.mjs is idempotent: re-running produces byte-identical
//     llms-full.txt. (This is also a stated acceptance criterion in the
//     issue body.)
//   - schema/meta.json is valid JSON for every page entry, and every JSON-LD
//     FAQ answer matches the visible FAQ text on the page (no cloaking).
//   - sitemap.xml parses as XML.
//   - Every website/*.html has a <link rel="canonical"> tag (no page is
//     missing one). This is also a stated acceptance criterion.
//   - llms.txt is non-empty and follows the llmstxt.org convention.
//   - robots.txt allows all major crawlers and does not block Ahrefs /
//     Semrush.
//   - og.png is a 1200x630 PNG.
//   - .well-known/agent-skills/index.json is valid JSON.
//   - .well-known/agent-skills/manta/SKILL.md has frontmatter and a body.
//   - website/updates/server.json's version matches package.json's version.
//     THIS ONE IS NOT COSMETIC: that manifest is the ONLY way a running box
//     learns a new server release exists (src/server/serverUpdate.mjs polls it
//     every 6h and drives the in-app update banner + the push notification).
//     It shipped as a `0.0.0` placeholder and no release ever bumped it, so
//     the banner had never fired for anyone and every box stayed on whatever
//     it installed with. Nothing else catches this: the deploy workflow
//     verifies the file is SERVED, not that it names the current version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function runNode(scriptRelPath) {
  execFileSync("node", [join(ROOT, scriptRelPath)], { stdio: "pipe", cwd: ROOT });
}

function runPython(scriptRelPath) {
  execFileSync("python3", [join(ROOT, scriptRelPath)], { stdio: "pipe", cwd: ROOT });
}

function read(p) {
  return readFileSync(join(ROOT, p), "utf8");
}

function sha(s) {
  // tiny sha-256 in plain JS — avoids a node:crypto import dance.
  // Not used for security; only for byte-identity checks.
  return execFileSync("sha256sum", ["-"], { input: s }).toString().split(" ")[0];
}

test("build-website-schema.mjs is idempotent on identical input", () => {
  const workdir = mkdtempSync(join(tmpdir(), "betschema-"));
  try {
    cpSync(join(ROOT, "website"), join(workdir, "website"), { recursive: true });
    cpSync(join(ROOT, "scripts"), join(workdir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "llms-install.md"), join(workdir, "llms-install.md"));
    execFileSync("node", [join(workdir, "scripts/build-website-schema.mjs")], { cwd: workdir });
    const after = {};
    for (const f of ["index.html", "vs-orca.html", "claude-code-mobile.html", "privacy.html"]) {
      after[f] = readFileSync(join(workdir, "website", f), "utf8");
    }
    execFileSync("node", [join(workdir, "scripts/build-website-schema.mjs")], { cwd: workdir });
    for (const f of Object.keys(after)) {
      const next = readFileSync(join(workdir, "website", f), "utf8");
      assert.equal(next, after[f], `${f} should be byte-identical on re-run`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("build-website-sitemap.mjs is idempotent on identical input", () => {
  runNode("scripts/build-website-sitemap.mjs");
  const first = read("website/sitemap.xml");
  runNode("scripts/build-website-sitemap.mjs");
  const second = read("website/sitemap.xml");
  assert.equal(first, second, "sitemap.xml must be byte-identical on re-run");
});

test("build-llms-full.mjs is idempotent on identical input", () => {
  runNode("scripts/build-llms-full.mjs");
  const first = read("website/llms-full.txt");
  runNode("scripts/build-llms-full.mjs");
  const second = read("website/llms-full.txt");
  assert.equal(first, second, "llms-full.txt must be byte-identical on re-run");
});

test("build-og-image.py is idempotent on identical input", () => {
  runPython("scripts/build-og-image.py");
  const first = readFileSync(join(ROOT, "website/og.png"));
  runPython("scripts/build-og-image.py");
  const second = readFileSync(join(ROOT, "website/og.png"));
  assert.equal(sha(first.toString("binary")), sha(second.toString("binary")), "og.png must be byte-identical on re-run");
});

test("schema/meta.json is valid JSON", () => {
  const schema = JSON.parse(read("website/schema/meta.json"));
  assert.ok(schema.pages, "meta.json must have #pages");
  assert.ok(Object.keys(schema.pages).length > 0, "#pages must not be empty");
});

test("every website/*.html has a rel=canonical link", () => {
  const files = readdirSync(join(ROOT, "website")).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const html = readFileSync(join(ROOT, "website", f), "utf8");
    assert.ok(
      /<link\s+rel=["']canonical["']/i.test(html),
      `${f} is missing a canonical link tag`,
    );
  }
});

test("sitemap.xml parses", () => {
  // mirrors the acceptance-criteria command in the issue body.
  execFileSync("python3", ["-c", "import xml.dom.minidom; xml.dom.minidom.parse('website/sitemap.xml')"], {
    cwd: ROOT,
  });
});

test("schema JSON files all parse (issue acceptance: website/schema/*.json)", () => {
  const files = execFileSync("ls", ["website/schema/"], { cwd: ROOT }).toString().trim().split("\n").filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "no schema files");
  execFileSync(
    "python3",
    ["-c", `import json, sys; [json.load(open(f)) for f in sys.argv[1:]]`, ...files.map((f) => `website/schema/${f}`)],
    { cwd: ROOT },
  );
});

test("every JSON-LD FAQ entry matches the visible FAQ text on the page", () => {
  const pagesWithFaq = [
    "index.html",
    "vs-orca.html",
    "vs-conductor.html",
    "vs-ssh-tmux.html",
    "claude-code-mobile.html",
    "claude-code-remote.html",
    "open-source.html",
    "pricing.html",
  ];
  for (const f of pagesWithFaq) {
    const html = read(`website/${f}`);
    const faqHtml = [...html.matchAll(/<h3>([^<]+)<\/h3><p>([\s\S]*?)<\/p>/g)].map((m) => ({
      q: m[1],
      a: stripTags(m[2]),
    }));
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faqLd = [];
    for (const b of blocks) {
      if (b["@type"] === "FAQPage") {
        for (const q of b.mainEntity) faqLd.push({ q: q.name, a: q.acceptedAnswer.text });
      }
    }
    assert.equal(faqHtml.length, faqLd.length, `${f}: FAQ count differs (HTML=${faqHtml.length}, JSON-LD=${faqLd.length})`);
    for (let i = 0; i < faqHtml.length; i++) {
      assert.equal(faqHtml[i].q, faqLd[i].q, `${f} Q${i + 1}: question mismatch`);
      assert.equal(faqHtml[i].a, faqLd[i].a, `${f} Q${i + 1}: answer mismatch`);
    }
  }
});

test("JSON-LD does not include any claims absent from the page (no cloaking)", () => {
  // Spot-check: every claim in SoftwareApplication/operatingSystem and
  // applicationCategory must be exactly what the issue allows.
  const html = read("website/index.html");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map((m) => JSON.parse(m[1]));
  const sw = blocks.find((b) => b["@type"] === "SoftwareApplication");
  assert.ok(sw, "homepage must have a SoftwareApplication JSON-LD block");
  assert.equal(sw.offers.price, "0", "SoftwareApplication offers price must be 0");
  assert.equal(sw.offers.priceCurrency, "USD", "SoftwareApplication offers priceCurrency must be USD");
  assert.equal(sw.applicationCategory, "DeveloperApplication", "SoftwareApplication applicationCategory must be DeveloperApplication");
  // Issue body: "Linux, macOS, iOS, Web" — must not include Android.
  assert.ok(!sw.operatingSystem.toLowerCase().includes("android"), "operatingSystem must NOT include Android");
  assert.match(sw.operatingSystem, /Linux/, "operatingSystem must include Linux");
  assert.match(sw.operatingSystem, /macOS/, "operatingSystem must include macOS");
  assert.match(sw.operatingSystem, /iOS/, "operatingSystem must include iOS");
  assert.match(sw.operatingSystem, /Web/, "operatingSystem must include Web");
  // No star count (would be cloaking — we are not asserting a number).
  assert.equal(sw.aggregateRating, undefined, "SoftwareApplication must NOT have aggregateRating (star count is cloaking)");
});

test("robots.txt allows all crawlers (does not block Ahrefs/Semrush)", () => {
  const robots = read("website/robots.txt");
  assert.match(robots, /User-agent:\s*\*/i, "robots.txt must declare User-agent: *");
  assert.match(robots, /Allow:\s*\//i, "robots.txt must allow the root");
  assert.match(robots, /AhrefsBot/, "robots.txt must explicitly allow AhrefsBot (Do NOT block — issue rule)");
  assert.match(robots, /SemrushBot/, "robots.txt must explicitly allow SemrushBot");
  assert.match(robots, /Content-Signal:/, "robots.txt must declare Content-Signal");
  assert.match(robots, /ai-train=yes/, "Content-Signal must allow AI training");
  assert.match(robots, /Sitemap:/, "robots.txt must reference sitemap.xml");
  assert.doesNotMatch(robots, /Disallow:\s*\//i, "robots.txt must NOT block the whole site");
});

test("llms.txt follows the llmstxt.org convention", () => {
  const llms = read("website/llms.txt");
  assert.match(llms, /^# /m, "llms.txt must start with an H1");
  assert.match(llms, /^> /m, "llms.txt must have a blockquote summary");
  assert.match(llms, /^## /m, "llms.txt must have at least one H2 section");
  assert.match(llms, /mantaui\.com\/llms-install\.md/, "llms.txt must reference llms-install.md");
  assert.match(llms, /mantaui\.com\/llms-full\.txt/, "llms.txt must reference llms-full.txt");
});

test("og.png is 1200x630 PNG", () => {
  const buf = readFileSync(join(ROOT, "website/og.png"));
  // PNG signature
  assert.equal(buf[0], 0x89);
  assert.equal(buf[1], 0x50);
  assert.equal(buf[2], 0x4e);
  assert.equal(buf[3], 0x47);
  // IHDR chunk: width (4 bytes BE) at offset 16, height at 20
  const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
  const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
  assert.equal(width, 1200, "og.png width must be 1200");
  assert.equal(height, 630, "og.png height must be 630");
});

test(".well-known/agent-skills/index.json is valid JSON", () => {
  const idx = JSON.parse(read(".well-known/agent-skills/index.json"));
  assert.ok(Array.isArray(idx.skills) && idx.skills.length > 0, "index.json must list at least one skill");
  assert.ok(idx.skills.find((s) => s.name === "manta"), "index.json must list the manta skill");
});

test(".well-known/agent-skills/manta/SKILL.md has YAML frontmatter and body", () => {
  const skill = read(".well-known/agent-skills/manta/SKILL.md");
  assert.match(skill, /^---\n/, "SKILL.md must start with YAML frontmatter delimiter");
  assert.match(skill, /\n---\n/, "SKILL.md must close the frontmatter with ---");
  assert.match(skill, /^name: manta$/m, "frontmatter must declare name: manta");
  assert.match(skill, /^license: MIT$/m, "frontmatter must declare license: MIT");
  assert.match(skill, /^description: /m, "frontmatter must declare a description");
  assert.ok(skill.length > 1000, "SKILL.md body must be substantial");
});

test("website/updates/server.json version matches package.json version", () => {
  const manifest = JSON.parse(read("website/updates/server.json"));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    manifest.version,
    pkg.version,
    "website/updates/server.json is what tells a running box a new server release exists " +
      "(src/server/serverUpdate.mjs polls it every 6h). If it lags package.json, no box is " +
      "ever offered the update. Bump it in the same commit as the version bump.",
  );
});

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
