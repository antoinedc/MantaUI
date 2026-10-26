// Auto-handoff, plugin half (docs/superpowers/specs/2026-10-26-auto-handoff.md §3, §4.4, §11, §15):
//   - the `handoff` tool in the manta V2 plugin (payload, output format, error path);
//   - the optimizer's budget note (gating matrix, thresholds, placement, fail-open,
//     and the wiring through the plugin's `context` hook).
// Pure — no network, no opencode binary.

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "..", "docs", "opencode-plugins-v2");
const stub = (code) =>
  code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`);

const TOKEN = "cd34".repeat(8);
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;
const savedHome = process.env.MANTA_STATE_HOME;

const mantaTree = await transpileTree(join(DOCS, "manta"), { rewrite: stub });
const optTree = await transpileTree(join(DOCS, "manta-optimizer"), { rewrite: stub });
after(async () => {
  await mantaTree.cleanup();
  await optTree.cleanup();
});
const imp = (tree, rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const { allTools } = await imp(mantaTree, "tools/index.mjs");
const handoffTool = allTools.find((t) => t.name === "handoff");
const note = await imp(optTree, "lib/handoff-note.mjs");
const optimizerDef = (await imp(optTree, "index.mjs")).default;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------------------ the tool

const CTX = { sessionID: "ses_abc", messageID: "msg_1", directory: "/work/proj" };
const BODY = "## Goal\nx\n## Current state\ny\n## Decisions (and why)\nz\n## Dead ends tried\n-\n## Next step\nn\n## Open questions\n-";

function fakeServer(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

describe("handoff tool", () => {
  test("is registered, V2-only, with the contract's input shape", () => {
    assert.ok(handoffTool, "handoff is in allTools");
    assert.deepEqual([...handoffTool.input.required].sort(), ["action", "body"]);
    assert.deepEqual(handoffTool.input.properties.action.enum, ["suggest", "handoff"]);
    assert.ok(handoffTool.input.properties.goal);
    assert.equal(handoffTool.input.additionalProperties, false);
    for (const h of ["## Goal", "## Current state", "## Decisions (and why)", "## Dead ends tried", "## Next step", "## Open questions"]) {
      assert.ok(handoffTool.description.includes(h), `description names ${h}`);
    }
  });

  test("suggest: POSTs the §11 payload with bearer auth, returns status line + marker", async () => {
    const calls = fakeServer(200, { handoff: { id: "hof_0123456789abcdefghij", state: "ready" } });
    const out = await handoffTool.execute({ action: "suggest", body: BODY, goal: "ship it" }, CTX);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "http://manta.test/api/handoff");
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(calls[0].body, { sessionId: "ses_abc", trigger: "agent", action: "suggest", goal: "ship it", body: BODY });
    assert.equal(out, "Handoff prompt ready below.\n<!-- manta-handoff:hof_0123456789abcdefghij -->");
    assert.match(out, /<!-- manta-handoff:([A-Za-z0-9_-]+) -->$/);
  });

  test("handoff: queued status line + marker; goal omitted from the payload when not given", async () => {
    const calls = fakeServer(200, { handoff: { id: "hof_zzzzzzzzzzzzzzzzzzzz" } });
    const out = await handoffTool.execute({ action: "handoff", body: BODY }, CTX);
    assert.equal(calls[0].body.action, "handoff");
    assert.equal("goal" in calls[0].body, false);
    assert.equal(out, "Handoff queued — it happens when this turn ends. End your turn now.\n<!-- manta-handoff:hof_zzzzzzzzzzzzzzzzzzzz -->");
  });

  test("server error: returns (not throws) an actionable string with the code and message", async () => {
    fakeServer(409, { error: "busy", message: "Another handoff is running for this session." });
    const out = await handoffTool.execute({ action: "handoff", body: BODY }, CTX);
    assert.equal(typeof out, "string");
    assert.match(out, /^Handoff failed:/);
    assert.match(out, /busy/);
    assert.match(out, /Another handoff is running for this session\./);
    assert.match(out, /no handoff will happen/);
    assert.doesNotMatch(out, /manta-handoff:/, "no marker on failure");
  });

  test("non-JSON error body and bare status are still reported", async () => {
    fakeServer(502, "bad gateway");
    assert.match(await handoffTool.execute({ action: "suggest", body: BODY }, CTX), /http_502.*bad gateway/);
    fakeServer(500, "");
    assert.match(await handoffTool.execute({ action: "suggest", body: BODY }, CTX), /http_500/);
  });

  test("network failure and a response without a usable id become error strings", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.match(await handoffTool.execute({ action: "suggest", body: BODY }, CTX), /could not reach manta-server \(ECONNREFUSED\)/);
    fakeServer(200, { handoff: {} });
    assert.match(await handoffTool.execute({ action: "suggest", body: BODY }, CTX), /returned no handoff id/);
    fakeServer(200, { handoff: { id: "bad id -->" } });
    assert.match(await handoffTool.execute({ action: "suggest", body: BODY }, CTX), /returned no handoff id/);
  });
});

// ------------------------------------------------------------ the budget note

const T0 = 1_000_000_000_000;
const MARKER = note.HANDOFF_GENERATE_MARKER;

/** A policy source whose answer the test controls. */
function harness({ authoritative = true, handoff, nowRef = { t: T0 } } = {}) {
  const state = { authoritative, handoff };
  const policies = {
    resolvePolicy: () => ({ authoritative: state.authoritative, policy: { enabled: false, handoff: state.handoff } }),
  };
  const run = createRun(note.createHandoffNote({ policies, now: () => nowRef.t }));
  return { state, nowRef, run };
}
const createRun = (fn) => (over = {}) => {
  const ev = {
    sessionID: "ses_n",
    messages: [
      { id: "msg_u", role: "user", content: [{ type: "text", text: "do the thing" }] },
      { id: "msg_a", role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
    ...over,
  };
  const before = ev.messages.length;
  const added = fn(ev);
  return { ev, added, appended: ev.messages.length - before };
};
const hp = (used, extra = {}) => ({ contextTokens: used, budget: 200_000, measuredAt: T0 - 1_000, mode: "auto", ...extra });

describe("handoff budget note — gating", () => {
  test("below 70% → no note", () => {
    const h = harness({ handoff: hp(139_999) });
    assert.equal(h.run().appended, 0);
  });

  test("a note is appended AFTER the last message, as a user text message, with the spec wording", () => {
    const h = harness({ handoff: hp(142_000) });
    const { ev, added, appended } = h.run();
    assert.equal(added, true);
    assert.equal(appended, 1);
    const last = ev.messages.at(-1);
    assert.equal(ev.messages.length, 3);
    assert.equal(last.role, "user");
    assert.equal(last.content.length, 1);
    assert.equal(last.content[0].type, "text");
    assert.equal(
      last.content[0].text,
      "Context: 142k of a 200k working budget. When you reach a natural stopping point and intend to keep working, call `handoff` with action `handoff`; if you're done, just finish.",
    );
    assert.equal(ev.messages[0].content[0].text, "do the thing", "earlier messages untouched");
  });

  test("a tool-result tail still gets the note after it (placement is positional, not role-based)", () => {
    const h = harness({ handoff: hp(150_000) });
    const messages = [
      { id: "msg_u", role: "user", content: [{ type: "text", text: "go" }] },
      { id: "msg_a", role: "assistant", content: [{ type: "tool-call", id: "t1", name: "shell", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", id: "t1", name: "shell", result: { type: "text", value: "x" } }] },
    ];
    const { ev, appended } = h.run({ messages });
    assert.equal(appended, 1);
    assert.equal(ev.messages.length, 4);
    assert.equal(ev.messages[2].role, "tool");
    assert.match(ev.messages[3].content[0].text, /^Context: 150k of a 200k/);
  });

  test("non-authoritative policy (cold / lastAny fallback) → none, even with a perfect handoff block", () => {
    const h = harness({ authoritative: false, handoff: hp(190_000) });
    assert.equal(h.run().appended, 0);
  });

  test("stale measuredAt (≥ 10 min) → none; just under → note", () => {
    const h = harness({ handoff: hp(150_000, { measuredAt: T0 - 600_000 }) });
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(150_000, { measuredAt: T0 - 599_999 });
    assert.equal(h.run().appended, 1);
  });

  test("mode off → none; suggest and auto → note", () => {
    const h = harness({ handoff: hp(150_000, { mode: "off" }) });
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(150_000, { mode: "suggest" });
    assert.equal(h.run().appended, 1);
    const h2 = harness({ handoff: hp(150_000, { mode: "auto" }) });
    assert.equal(h2.run().appended, 1);
  });

  test("null / missing / malformed handoff field → none", () => {
    for (const handoff of [null, undefined, "x", {}, hp(150_000, { budget: 0 }), hp(150_000, { budget: "200000" }), hp(150_000, { contextTokens: NaN }), hp(150_000, { mode: "bogus" })]) {
      assert.equal(harness({ handoff }).run().appended, 0, JSON.stringify(handoff));
    }
  });

  test("a generate request (marker in the last user content) → none, and consumes no threshold", () => {
    const h = harness({ handoff: hp(150_000) });
    const gen = [{ id: "msg_g", role: "user", content: [{ type: "text", text: `${MARKER}\nWrite the handoff` }] }];
    assert.equal(h.run({ messages: gen }).appended, 0);
    // string content is recognised too
    assert.equal(h.run({ messages: [{ role: "user", content: `${MARKER} x` }] }).appended, 0);
    assert.equal(h.run().appended, 1, "the 70% note is still owed to the next normal request");
  });

  test("the marker only counts in the LAST user message", () => {
    const h = harness({ handoff: hp(150_000) });
    const messages = [
      { id: "msg_g", role: "user", content: [{ type: "text", text: MARKER }] },
      { id: "msg_a", role: "assistant", content: [{ type: "text", text: "done" }] },
      { id: "msg_u", role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    assert.equal(h.run({ messages }).appended, 1);
  });

  test("missing sessionID / non-array messages → none, no throw", () => {
    const h = harness({ handoff: hp(150_000) });
    assert.equal(h.run({ sessionID: "" }).appended, 0);
    const fn = note.createHandoffNote({ policies: { resolvePolicy: () => ({ authoritative: true, policy: { handoff: hp(150_000) } }) } });
    assert.equal(fn({ sessionID: "ses_x", messages: null }), false);
    assert.equal(fn(undefined), false);
  });
});

describe("handoff budget note — thresholds per (sessionID, budget)", () => {
  test("70% once, no repeat while above, 90% once, no repeat after", () => {
    const h = harness({ handoff: hp(139_000) });
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(140_000);
    assert.equal(h.run().appended, 1, "first crossing of 70%");
    h.state.handoff = hp(160_000);
    assert.equal(h.run().appended, 0, "stays above 70% → silent");
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(180_000);
    assert.equal(h.run().appended, 1, "crossing 90%");
    h.state.handoff = hp(195_000);
    assert.equal(h.run().appended, 0, "stays above 90% → silent");
  });

  test("a first sighting at ≥ 90% fires once, then neither threshold repeats", () => {
    const h = harness({ handoff: hp(190_000) });
    assert.equal(h.run().appended, 1);
    h.state.handoff = hp(150_000);
    assert.equal(h.run().appended, 0, "the 70% note is not owed after a 90% sighting");
    h.state.handoff = hp(195_000);
    assert.equal(h.run().appended, 0);
  });

  test("dropping below 50% resets: climbing back past 70% notes again (and 90% again)", () => {
    const h = harness({ handoff: hp(150_000) });
    assert.equal(h.run().appended, 1);
    h.state.handoff = hp(110_000); // 55% — between 50 and 70: not a reset
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(150_000);
    assert.equal(h.run().appended, 0, "no reset happened at 55%");
    h.state.handoff = hp(99_000); // < 50% — compaction happened
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(150_000);
    assert.equal(h.run().appended, 1, "70% again after a reset");
    h.state.handoff = hp(185_000);
    assert.equal(h.run().appended, 1, "90% again after a reset");
  });

  test("state is keyed by session AND budget", () => {
    const h = harness({ handoff: hp(150_000) });
    assert.equal(h.run().appended, 1);
    assert.equal(h.run({ sessionID: "ses_other" }).appended, 1, "another session has its own state");
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(75_000, { budget: 100_000 });
    assert.equal(h.run().appended, 1, "a different budget (model switch) is a fresh key");
  });

  test("gated-out requests neither fire nor reset state", () => {
    const h = harness({ handoff: hp(150_000) });
    assert.equal(h.run().appended, 1);
    h.state.handoff = hp(10_000, { mode: "off" }); // would reset, but off is skipped entirely
    assert.equal(h.run().appended, 0);
    h.state.handoff = hp(10_000, { measuredAt: T0 - 3_600_000 }); // stale: same
    assert.equal(h.run().appended, 0);
    h.state.authoritative = false;
    assert.equal(h.run().appended, 0);
    h.state.authoritative = true;
    h.state.handoff = hp(150_000);
    assert.equal(h.run().appended, 0, "state survived: no repeat");
  });
});

describe("handoff budget note — fail open", () => {
  test("a throwing policy source → no note, no throw, state unchanged", () => {
    let boom = true;
    const policies = {
      resolvePolicy: () => {
        if (boom) throw new Error("policy exploded");
        return { authoritative: true, policy: { handoff: hp(150_000) } };
      },
    };
    const fn = note.createHandoffNote({ policies, now: () => T0 });
    const ev = { sessionID: "ses_f", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    assert.doesNotThrow(() => assert.equal(fn(ev), false));
    assert.equal(ev.messages.length, 1);
    boom = false;
    assert.equal(fn(ev), true, "the throw did not consume the threshold");
  });

  test("a frozen messages array (push throws) → no note, no throw, threshold not consumed", () => {
    const h = harness({ handoff: hp(150_000) });
    const frozen = Object.freeze([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    const { added } = h.run({ messages: frozen });
    assert.equal(added, false);
    assert.equal(h.run().appended, 1);
  });
});

// ------------------------------------------------------- wiring in the plugin

describe("optimizer plugin `context` hook wiring", () => {
  let home;
  let policyBody;
  beforeEach(() => {
    home = mkdtempSync(join(savedHome ?? tmpdir(), "handoff-hook-"));
    process.env.MANTA_STATE_HOME = home;
    policyBody = null;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/optimizer/policy")) {
        return policyBody ? new Response(JSON.stringify(policyBody)) : new Response("{}", { status: 503 });
      }
      return new Response("{}", { status: 404 });
    };
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MANTA_STATE_HOME;
    else process.env.MANTA_STATE_HOME = savedHome;
  });

  async function boot() {
    const hooks = {};
    await optimizerDef.setup({
      location: { directory: "/proj" },
      session: { hook: async (k, fn) => void (hooks[k] = fn), get: async () => ({}) },
    });
    return async (event) => {
      hooks.context(event);
      await new Promise((r) => setTimeout(r, 30));
    };
  }
  const event = () => ({
    sessionID: "ses_w",
    messages: [{ id: "msg_u", role: "user", content: [{ type: "text", text: "go" }] }],
  });

  test("cold session: no note; once the policy has landed (authoritative) the note rides after the last message, once", async () => {
    policyBody = { enabled: false, handoff: { contextTokens: 150_000, budget: 200_000, measuredAt: Date.now(), mode: "auto" } };
    const run = await boot();
    const cold = event();
    await run(cold);
    assert.equal(cold.messages.length, 1, "cold → provisional policy → no note");
    const warm = event();
    await run(warm);
    assert.equal(warm.messages.length, 2);
    assert.match(warm.messages[1].content[0].text, /^Context: 150k of a 200k working budget\./);
    const again = event();
    await run(again);
    assert.equal(again.messages.length, 1, "no repeat at the same level");
  });

  test("policy without a handoff block (server not upgraded) → never a note", async () => {
    policyBody = { enabled: false };
    const run = await boot();
    await run(event());
    const ev = event();
    await run(ev);
    assert.equal(ev.messages.length, 1);
  });
});
