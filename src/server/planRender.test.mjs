// Tests for planRender.mjs — single-HTML plan publish orchestration (BET-987).
// All I/O is injected (fake readFile / writeFile / mkdir / register / srcDir),
// so no live HTTP and no real page files. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { publishPlanBundle } from "./planRender.mjs";
import { planSubdomain } from "./planPage.mjs";

const BASE_URL = "https://0123abc.boxes.mantaui.com";
const SESSION_ID = "sess-123xYZ";
const SESSION_DIR = "/sessions/sess-123xYZ";

function bundle(sections, bodyTail = "") {
  const body =
    `<h2 id="${sections[0].id}">${sections[0].heading}</h2>` +
    sections
      .slice(1)
      .map((s) => `<h2 id="${s.id}">${s.heading}</h2>`)
      .join("") +
    bodyTail;
  return `<script type="application/json" id="plan-meta">${JSON.stringify({
    title: "Ship the thing",
    sections,
  })}</script>
${body}`;
}

function makeDeeps({ readText, registerReturn } = {}) {
  const calls = {
    readFile: null,
    writtenFile: null,
    register: null,
    registerCalls: [],
  };
  return {
    calls,
    deeps: {
      baseUrl: BASE_URL,
      srcDir: () => "/stage",
      readFile: async (p) => {
        calls.readFile = p;
        if (readText !== undefined) return readText;
        throw new Error("no fake read");
      },
      writeFile: async (p, data) => {
        calls.writtenFile = { p, data };
      },
      mkdir: async () => {},
      register: async (args, deps) => {
        calls.registerCalls.push({ args, deps });
        if (registerReturn !== undefined) return registerReturn;
        return { ok: true, url: `${BASE_URL}/pages/${args.subdomain}`, subdomain: args.subdomain };
      },
    },
  };
}

test("publishPlanBundle rejects a plan file path that escapes the session directory", async () => {
  const { calls, deeps } = makeDeeps();
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "../evil.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /outside the session directory/);
  assert.equal(calls.registerCalls.length, 0, "register never called");
});

test("publishPlanBundle rejects a missing session directory", async () => {
  const { deeps } = makeDeeps();
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "plan.html", sessionDir: "" },
    deeps,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /session directory is required/);
});

test("publishPlanBundle returns (not throws) a missing-meta error", async () => {
  const { calls, deeps } = makeDeeps({ readText: "<html><body>no meta</body></html>" });
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "plan.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "no plan-meta");
  assert.equal(calls.registerCalls.length, 0, "register never called on parse failure");
});

test("publishPlanBundle returns (not throws) a missing-anchor error", async () => {
  // Section references an id that's NOT in the body → renderPlanDoc fails.
  const text = `<script type="application/json" id="plan-meta">${JSON.stringify({
    title: "T",
    sections: [{ id: "missing", heading: "Missing" }],
  })}</script>
<h2 id="overview">Overview</h2>`;
  const { calls, deeps } = makeDeeps({ readText: text });
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "plan.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "section id 'missing' not found in body");
  assert.equal(calls.registerCalls.length, 0, "register never called on render failure");
});

test("publishPlanBundle on success calls register with ttlHours 0 and echoes the URL", async () => {
  const sections = [
    { id: "overview", heading: "Overview" },
    { id: "steps", heading: "Steps" },
  ];
  const text = bundle(sections);
  const { calls, deeps } = makeDeeps({ readText: text });
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "plan.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, true);
  const expectedSub = planSubdomain(SESSION_ID);
  assert.equal(result.url, `${BASE_URL}/pages/${expectedSub}`);
  assert.equal(calls.registerCalls.length, 1);
  const { args, deps } = calls.registerCalls[0];
  assert.equal(args.subdomain, expectedSub);
  assert.equal(args.ttlHours, 0, "TTL 0 — never expires");
  assert.equal(args.sessionID, SESSION_ID);
  assert.equal(deps.baseUrl, BASE_URL);
  assert.ok(args.filePath, "a staged file path is handed to register");
});

test("publishPlanBundle confines a relative in-session path by resolving against sessionDir", async () => {
  const text = bundle([{ id: "overview", heading: "Overview" }]);
  const { calls, deeps } = makeDeeps({ readText: text });
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: ".opencode/plans/plan.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, true);
  assert.ok(calls.readFile.includes(SESSION_DIR), "read resolved against sessionDir");
});

test("publishPlanBundle surfaces an I/O read failure as {ok:false,error}, not a throw", async () => {
  const { deeps } = makeDeeps();
  const result = await publishPlanBundle(
    { sessionID: SESSION_ID, file: "missing.html", sessionDir: SESSION_DIR },
    deeps,
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});
