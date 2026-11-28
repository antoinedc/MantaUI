// "This might deserve an agent": the counter of Dev handoffs by kind of work, the stored offers and their read/ack/answer contracts, the
// retry-safe accept, the uncapped "don't ask again" set (docs/superpowers/specs/2026-11-28-research-layer.md US4, §6.5, §6.6).
// Fakes for the store, the model, opencode and the clock; nothing live.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAgentSuggestions } from "./agentSuggestions.mjs";

const DAY = 86_400_000;
const CHAT = "ses_manta_1";
const NEVER = new Promise(() => {}); // a process that died in the middle of a call

/** A box: in-memory stores, a steerable clock, a model that labels by title and answers the offer check, and a recording opencode. */
function box(over = {}) {
  const w = {
    clock: Date.parse("2026-11-28T10:00:00Z"),
    docs: { sugg: null, supp: null },
    labels: {}, // title → the label the model gives (default: "write release notes")
    labelCalls: [],
    offerCalls: [],
    offerAnswer: JSON.stringify({ label: "weekly release notes", verdict: "agent", why: "It needs its own tone and could run every Friday." }),
    failLabel: false,
    failOffer: false,
    posted: [], // { sessionId, text, messageID, delivery }
    messages: new Map(), // sessionId → Set of message ids present
    sendFails: 0,
    readState: "missing", // what the existence check answers when the id isn't in `messages`
    busy: false,
    pubs: [],
    jobs: {}, // jobId → { title, prompt }
    enabled: true,
    ...over,
  };
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const deps = () => ({
    store: { load: async () => clone(w.docs.sugg), save: async (d) => void (w.docs.sugg = clone(d)) },
    suppressStore: { load: async () => clone(w.docs.supp), save: async (d) => void (w.docs.supp = clone(d)) },
    generate: async ({ instruction }) => {
      if (/Answer with the label only/.test(instruction)) {
        w.labelCalls.push(instruction);
        if (w.labelGate) await w.labelGate;
        if (w.failLabel) return "";
        const title = /Title: (.*)/.exec(instruction)?.[1]?.trim() ?? "";
        return w.labels[title] ?? "write release notes";
      }
      w.offerCalls.push(instruction);
      return w.failOffer ? "" : w.offerAnswer;
    },
    readJobs: async (ids) => Object.fromEntries(ids.filter((id) => w.jobs[id]).map((id) => [id, w.jobs[id]])),
    oc: {
      readMessageStrict: async (sid, mid) => ({ state: w.messages.get(sid)?.has(mid) ? "found" : w.readState }),
      sendPrompt: async (a) => {
        if (w.sendHangs) return NEVER;
        if (w.sendFails > 0) {
          w.sendFails--;
          throw new Error("opencode is down at /secret/path");
        }
        w.posted.push(a);
        (w.messages.get(a.sessionId) ?? w.messages.set(a.sessionId, new Set()).get(a.sessionId)).add(a.messageID);
        return { ok: true };
      },
      listActiveSessionIds: async () => (w.busy ? [CHAT] : []),
    },
    enabled: async () => w.enabled,
    disable: async () => void (w.disabledCalls = (w.disabledCalls ?? 0) + 1),
    publish: (e) => w.pubs.push(e),
    now: () => w.clock,
    log: { warn: () => {} },
  });
  const make = () => createAgentSuggestions(deps());
  return { w, make, engine: make() };
}

let n = 0;
/** One accepted handoff to Dev from the led chat; resolves once its (background) labelling and counting are done. */
async function handoff(b, title = "Release notes for v1", extra = {}) {
  const jobId = `job_${++n}`;
  b.w.jobs[jobId] = { title, prompt: `Write the release notes for ${title}. Merged PRs since the last tag.\n\n---\nYour brief for this project:\nsecret seat text` };
  const r = b.engine.noteHandoff({ jobId, title, brief: `Write the release notes for ${title}. Merged PRs since the last tag.`, project: "p1", chat: CHAT, anchorMessageId: `msg_anchor_${n}`, lead: true, ...extra });
  await r.pending;
  return jobId;
}
const three = async (b) => {
  for (const t of ["Release notes for v1", "Changelog for v2", "Release notes for v3"]) await handoff(b, t);
};
const offersOf = async (b, chat = CHAT) => (await b.engine.list({ sessionId: chat })).offers;

describe("counting by kind of work (AC-4.2b, AC-4.8)", () => {
  test("three similar handoffs: exactly one offer, three labelling calls and one offer call; a fourth adds a label call and nothing else", async () => {
    const b = box();
    await three(b);
    assert.equal((await offersOf(b)).length, 1);
    assert.equal(b.w.labelCalls.length, 3);
    assert.equal(b.w.offerCalls.length, 1);
    await handoff(b, "Release notes for v4");
    assert.equal((await offersOf(b)).length, 1, "no second offer");
    assert.equal(b.w.labelCalls.length, 4);
    assert.equal(b.w.offerCalls.length, 1, "no second offer call");
  });

  test("three handoffs of different kinds create nothing", async () => {
    const b = box({ labels: { A: "write release notes", B: "fix flaky test", C: "bump dependency" } });
    for (const t of ["A", "B", "C"]) await handoff(b, t);
    assert.equal((await offersOf(b)).length, 0);
    assert.equal(b.w.offerCalls.length, 0);
  });

  test("labels that differ only in case, plural or filler count as one kind", async () => {
    const b = box({ labels: { A: "write release notes", B: "Write the release note", C: "write the release notes" } });
    for (const t of ["A", "B", "C"]) await handoff(b, t);
    assert.equal((await offersOf(b)).length, 1);
  });

  test("the handoff is never delayed: noteHandoff returns before the labelling call is answered, and the count lands when it is", async () => {
    const b = box();
    let release;
    b.w.labelGate = new Promise((r) => (release = r));
    const r = b.engine.noteHandoff({ jobId: "job_x", title: "Release notes for v1", brief: "b", project: "p", chat: CHAT, anchorMessageId: "m", lead: true });
    assert.ok(r && typeof r.pending?.then === "function", "returns at once with a promise of the background work");
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(b.w.labelCalls.length, 1, "the call is in flight");
    assert.equal(b.w.docs.sugg, null, "nothing counted yet");
    release();
    await r.pending;
    assert.equal(b.w.docs.sugg.items.length, 1);
  });

  test("a labelling failure just means that handoff isn't counted; the next one is", async () => {
    const b = box({ failLabel: true });
    await handoff(b, "Release notes for v1");
    b.w.failLabel = false;
    await handoff(b, "Release notes for v2");
    await handoff(b, "Release notes for v3");
    assert.equal((await offersOf(b)).length, 0, "only two were counted");
    await handoff(b, "Release notes for v4");
    assert.equal((await offersOf(b)).length, 1);
  });

  test("the labelling prompt is offered the labels already used on the box", async () => {
    const b = box({ labels: { A: "fix flaky test" } });
    await handoff(b, "A");
    await handoff(b, "B");
    assert.match(b.w.labelCalls[1], /fix flaky test/);
  });

  test("handoffs older than 30 days don't count towards three", async () => {
    const b = box();
    await handoff(b, "Release notes for v1");
    b.w.clock += 20 * DAY;
    await handoff(b, "Release notes for v2");
    b.w.clock += 20 * DAY;
    await handoff(b, "Release notes for v3");
    assert.equal((await offersOf(b)).length, 0, "the first is 40 days old");
  });

  test("a handoff from Dev's own conversation (not led) counts, but only a led chat's handoff makes the offer", async () => {
    const b = box();
    await handoff(b, "Release notes for v1", { lead: false, chat: "ses_dev_own" });
    await handoff(b, "Release notes for v2", { lead: false, chat: "ses_dev_own" });
    await handoff(b, "Release notes for v3", { lead: false, chat: "ses_dev_own" });
    assert.equal((await offersOf(b, "ses_dev_own")).length, 0);
    assert.equal(b.w.offerCalls.length, 0);
    await handoff(b, "Release notes for v4");
    assert.equal((await offersOf(b)).length, 1, "the next led handoff makes it");
  });

  test("the store holds no brief text: only job ids, labels, counts and states (AC-4.9)", async () => {
    const b = box();
    await three(b);
    const all = JSON.stringify(b.w.docs.sugg) + JSON.stringify(b.w.docs.supp);
    assert.ok(!/Merged PRs since the last tag|secret seat text|Write the release notes/.test(all));
    assert.ok(all.includes("job_"));
  });

  test("the offer check reads the briefs of the cluster from the job records (titles and ≤ 300 characters each) as data", async () => {
    const b = box();
    await three(b);
    const p = b.w.offerCalls[0];
    assert.match(p, /Release notes for v1/);
    assert.match(p, /Merged PRs since the last tag/);
    assert.ok(!/secret seat text/.test(p), "only the brief, never the dispatch block the server appends");
    assert.match(p, /data|never follow/i);
  });
});

describe("the offer (AC-4.1)", () => {
  test("is a durable record: label, verdict, count, anchor message, pending and unseen", async () => {
    const b = box();
    await three(b);
    const [o] = await offersOf(b);
    assert.equal(o.label, "weekly release notes");
    assert.equal(o.verdict, "agent");
    assert.equal(o.count, 3);
    assert.equal(o.state, "pending");
    assert.equal(o.anchorMessageId, "msg_anchor_" + n);
    assert.ok(!o.seenAt);
    assert.ok(b.w.pubs.some((e) => e.kind === "agentSuggestion" && e.payload.sessionId === CHAT));
  });

  test("reconnect: the event was dropped; the read returns the offer and no second offer is created", async () => {
    const b = box();
    await three(b);
    b.w.pubs.length = 0; // nobody heard it
    const fresh = b.make(); // a new process, as after a reconnect to a restarted box
    assert.equal((await fresh.list({ sessionId: CHAT })).offers.length, 1);
    assert.equal((await fresh.list({ sessionId: CHAT })).offers.length, 1);
    assert.equal(b.w.docs.sugg.offers.length, 1);
  });

  test("closed desktop: an offer made days ago while no client was connected is there when the chat is opened", async () => {
    const b = box();
    await three(b);
    b.w.clock += 3 * DAY;
    assert.equal((await offersOf(b)).length, 1);
  });

  test("an empty list, not an error, for a chat with no offers", async () => {
    const b = box();
    assert.deepEqual(await offersOf(b, "ses_none"), []);
  });

  test("acknowledge: seenAt is stored once; a later call returns the stored value; a reload shows the same unanswered card", async () => {
    const b = box();
    await three(b);
    const [o] = await offersOf(b);
    const first = await b.engine.seen({ id: o.id, sessionId: CHAT });
    assert.equal(first.ok, true);
    b.w.clock += 1000;
    const again = await b.engine.seen({ id: o.id, sessionId: CHAT });
    assert.equal(again.seenAt, first.seenAt);
    const [reloaded] = await offersOf(b);
    assert.equal(reloaded.id, o.id);
    assert.equal(reloaded.state, "pending");
    assert.equal(reloaded.seenAt, first.seenAt);
  });

  test("seen: an unknown id or another chat's offer is refused", async () => {
    const b = box();
    await three(b);
    const [o] = await offersOf(b);
    assert.equal((await b.engine.seen({ id: "o_nope", sessionId: CHAT })).ok, false);
    assert.equal((await b.engine.seen({ id: o.id, sessionId: "ses_other" })).ok, false);
  });

  test("two clients: the first answer wins and the second gets already:<state>", async () => {
    const b = box();
    await three(b);
    const [o] = await offersOf(b);
    const a = await b.engine.act({ id: o.id, action: "later" });
    assert.equal(a.ok, true);
    const c = await b.engine.act({ id: o.id, action: "never" });
    assert.deepEqual({ ok: c.ok, already: c.already }, { ok: true, already: "later" });
    const [after] = await offersOf(b);
    assert.equal(after.state, "answered");
    assert.equal(after.answer, "later");
  });

  test("never rendered: withdrawn after 7 days, the cluster goes back to open, the next similar handoff may offer it again, and it isn't a Not now", async () => {
    const b = box();
    await three(b);
    b.w.clock += 7 * DAY + 1000;
    await b.engine.sweep();
    assert.equal((await offersOf(b)).length, 0, "withdrawn offers are not listed");
    assert.equal(b.w.docs.sugg.offers[0].state, "withdrawn");
    await handoff(b, "Release notes for v4");
    const offers = await offersOf(b);
    assert.equal(offers.length, 1, "offered again");
    assert.equal(b.w.offerCalls.length, 2);
  });

  test("a seen but unanswered offer stays (it isn't withdrawn) and doesn't block another kind", async () => {
    const b = box({ labels: { A: "fix flaky test" } });
    await three(b);
    const [o] = await offersOf(b);
    await b.engine.seen({ id: o.id, sessionId: CHAT });
    b.w.clock += 30 * DAY;
    await b.engine.sweep();
    assert.equal((await offersOf(b)).length, 1);
    b.w.clock += 2 * DAY; // past the per-chat daily cap of the first
    for (let i = 0; i < 3; i++) await handoff(b, "A");
    assert.equal((await offersOf(b)).length, 2);
  });

  test("the offer check failing makes no offer and leaves the cluster due: the next similar handoff tries again", async () => {
    const b = box({ failOffer: true });
    await three(b);
    assert.equal((await offersOf(b)).length, 0);
    b.w.failOffer = false;
    await handoff(b, "Release notes for v4");
    assert.equal((await offersOf(b)).length, 1);
  });

  test("an answer that isn't {label, verdict agent|skill, why} is a failed check", async () => {
    const b = box({ offerAnswer: "Sure! I think a skill would be good." });
    await three(b);
    assert.equal((await offersOf(b)).length, 0);
  });

  test("a skill verdict is kept", async () => {
    const b = box({ offerAnswer: JSON.stringify({ label: "weekly release notes", verdict: "skill", why: "The steps are the same." }) });
    await three(b);
    assert.equal((await offersOf(b))[0].verdict, "skill");
  });
});

describe("answers (AC-4.3, AC-4.3b, AC-4.4)", () => {
  async function offered(over) {
    const b = box(over);
    await three(b);
    const [o] = await offersOf(b);
    return { b, o };
  }

  test("Make an agent posts ONE user message in the chat with the earlier briefs; the cluster is accepted; nothing is created", async () => {
    const { b, o } = await offered();
    const r = await b.engine.act({ id: o.id, action: "agent" });
    assert.equal(r.ok, true);
    assert.ok(r.posted?.startsWith("msg_"));
    assert.equal(b.w.posted.length, 1);
    const p = b.w.posted[0];
    assert.equal(p.sessionId, CHAT);
    assert.equal(p.messageID, r.posted);
    assert.match(p.text, /^Yes — build a dedicated agent for weekly release notes\./);
    assert.match(p.text, /Earlier briefs: .*Release notes for v1.*Changelog for v2.*Release notes for v3/);
    assert.equal(b.w.docs.sugg.clusters["write release note"].state, "accepted");
    const [after] = await offersOf(b);
    assert.equal(after.accept.state, "posted");
  });

  test("Make a skill uses the skill wording", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "skill" });
    assert.match(b.w.posted[0].text, /^Yes — make a skill for weekly release notes\./);
  });

  test("Not now and Don't ask again post nothing and are a single state write", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "later" });
    assert.equal(b.w.posted.length, 0);
    const b2 = await offered();
    await b2.b.engine.act({ id: b2.o.id, action: "never" });
    assert.equal(b2.b.w.posted.length, 0);
    assert.equal(b2.b.w.docs.supp.entries.length, 1);
  });

  test("an unknown action or offer is refused with a sentence", async () => {
    const { b, o } = await offered();
    assert.equal((await b.engine.act({ id: o.id, action: "delete" })).ok, false);
    assert.equal((await b.engine.act({ id: "o_nope", action: "agent" })).ok, false);
  });

  test("crash after the state write, before the post: the next boot posts it once with that id and marks it posted", async () => {
    const { b, o } = await offered({ sendHangs: true });
    void b.engine.act({ id: o.id, action: "agent" }); // the process dies inside the post
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(b.w.docs.sugg.offers[0].accept.state, "posting");
    const messageId = b.w.docs.sugg.offers[0].accept.messageId;
    b.w.sendHangs = false;
    const boot = b.make();
    await boot.recover({ boot: true });
    assert.equal(b.w.posted.length, 1);
    assert.equal(b.w.posted[0].messageID, messageId);
    assert.equal(b.w.docs.sugg.offers[0].accept.state, "posted");
    await boot.recover({ boot: true });
    assert.equal(b.w.posted.length, 1, "exactly once");
  });

  test("the same recovery runs on the next read of that chat", async () => {
    const { b, o } = await offered({ sendHangs: true });
    void b.engine.act({ id: o.id, action: "agent" });
    await new Promise((r) => setTimeout(r, 5));
    b.w.sendHangs = false;
    const fresh = b.make();
    const { offers } = await fresh.list({ sessionId: CHAT });
    assert.equal(b.w.posted.length, 1);
    assert.equal(offers[0].accept.state, "posted");
  });

  test("crash after the post, before marking done: recovery finds the message by id, marks it posted and posts nothing", async () => {
    const { b, o } = await offered({ sendHangs: true });
    void b.engine.act({ id: o.id, action: "agent" });
    await new Promise((r) => setTimeout(r, 5));
    const messageId = b.w.docs.sugg.offers[0].accept.messageId;
    b.w.messages.set(CHAT, new Set([messageId])); // it did reach the chat
    b.w.sendHangs = false;
    await b.make().recover({ boot: true });
    assert.equal(b.w.posted.length, 0);
    assert.equal(b.w.docs.sugg.offers[0].accept.state, "posted");
  });

  test("the RPC retried — sequentially and concurrently — posts one message; the repeat gets already + the same id", async () => {
    const { b, o } = await offered();
    const [x, y] = await Promise.all([b.engine.act({ id: o.id, action: "agent" }), b.engine.act({ id: o.id, action: "agent" })]);
    assert.equal(b.w.posted.length, 1);
    const winner = [x, y].find((r) => !r.already);
    const repeat = [x, y].find((r) => r.already);
    assert.ok(winner && repeat);
    assert.equal(repeat.already, "agent");
    const third = await b.engine.act({ id: o.id, action: "agent" });
    assert.deepEqual({ ok: third.ok, already: third.already, posted: third.posted }, { ok: true, already: "agent", posted: b.w.posted[0].messageID });
    assert.equal(b.w.posted.length, 1);
  });

  test("post fails (opencode down): the offer stays posting and says sending; the sweep retries with back-off; the 5th failure is failed; Retry posts once with the SAME id", async () => {
    const { b, o } = await offered({ sendFails: 99 });
    const r = await b.engine.act({ id: o.id, action: "agent" });
    assert.equal(r.sending, true);
    const id = b.w.docs.sugg.offers[0].accept.messageId;
    assert.equal(b.w.docs.sugg.offers[0].accept.attempts, 1);
    assert.equal(b.w.docs.sugg.offers[0].accept.lastError.includes("/secret/path"), false, "a safe sentence, never the raw error");
    await b.engine.sweep();
    assert.equal(b.w.docs.sugg.offers[0].accept.attempts, 1, "too early: the back-off hasn't passed");
    const waits = [30_000, 90_000, 240_000, 480_000];
    for (const wait of waits) {
      b.w.clock += wait + 1;
      await b.engine.sweep();
    }
    const acc = b.w.docs.sugg.offers[0].accept;
    assert.equal(acc.attempts, 5);
    assert.equal(acc.state, "failed");
    assert.equal(acc.messageId, id);
    assert.equal(b.w.posted.length, 0);
    b.w.sendFails = 0;
    const retry = await b.engine.act({ id: o.id, action: "agent" });
    assert.equal(retry.already, "agent");
    assert.equal(b.w.posted.length, 1);
    assert.equal(b.w.posted[0].messageID, id);
    assert.equal(b.w.docs.sugg.offers[0].accept.state, "posted");
  });

  test("an unreadable chat (the existence check can't tell) counts as a failed attempt and posts nothing", async () => {
    const { b, o } = await offered({ readState: "unknown" });
    const r = await b.engine.act({ id: o.id, action: "agent" });
    assert.equal(r.sending, true);
    assert.equal(b.w.posted.length, 0);
  });

  test("busy chat: the post is queued so it never steers a running turn; idle: no delivery", async () => {
    const busy = await offered({ busy: true });
    await busy.b.engine.act({ id: busy.o.id, action: "agent" });
    assert.equal(busy.b.w.posted[0].delivery, "queue");
    const idle = await offered();
    await idle.b.engine.act({ id: idle.o.id, action: "agent" });
    assert.equal(idle.b.w.posted[0].delivery, undefined);
  });

  test("Not now: not offered again until 3 more similar handoffs; a second Not now is for good", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "later" });
    await handoff(b, "Release notes for v4");
    await handoff(b, "Release notes for v5");
    assert.equal(b.w.offerCalls.length, 1, "two more are not enough");
    b.w.clock += 2 * DAY; // past the per-chat daily cap
    await handoff(b, "Release notes for v6");
    const offers = await offersOf(b);
    assert.equal(offers.length, 2);
    await b.engine.act({ id: offers[1].id, action: "later" });
    for (let i = 0; i < 6; i++) {
      b.w.clock += 2 * DAY;
      await handoff(b, `Release notes for w${i}`);
    }
    assert.equal((await offersOf(b)).length, 2, "never again");
    assert.equal(b.w.docs.supp.entries.length, 1);
  });

  test("the read says whether a Not now was the last one, so the card can say it won't be offered again", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "later" });
    assert.ok(!(await offersOf(b))[0].final, "the first Not now: it will ask again");
    await handoff(b, "Release notes for v4");
    b.w.clock += 2 * DAY;
    await handoff(b, "Release notes for v5");
    await handoff(b, "Release notes for v6");
    const second = (await offersOf(b))[1];
    await b.engine.act({ id: second.id, action: "later" });
    const after = await offersOf(b);
    assert.equal(after[1].final, true);
    assert.ok(!after[0].final, "the first one still reads as a Not now that will ask again");
  });

  test("Don't ask again survives 600 unrelated handoffs and 100 days of history: three similar briefs never make an offer", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "never" });
    for (let i = 0; i < 600; i++) {
      b.w.labels[`U${i}`] = `do unrelated thing ${i}`;
      b.w.clock += 4 * 60_000;
      await handoff(b, `U${i}`);
    }
    b.w.clock += 100 * DAY;
    await b.engine.sweep();
    assert.ok(b.w.docs.sugg.items.length <= 500, "the history is capped");
    assert.equal(b.w.docs.supp.entries.length, 1, "the suppression set is not");
    const before = b.w.offerCalls.length;
    for (const t of ["Release notes for z1", "Changelog for z2", "Release notes for z3"]) await handoff(b, t);
    assert.equal((await offersOf(b)).filter((x) => x.state === "pending").length, 0);
    assert.equal(b.w.offerCalls.length, before);
  });

  test("at the suppression set's sanity ceiling a dismissal still succeeds by turning suggestions off, and says so", async () => {
    const { b, o } = await offered();
    b.w.docs.supp = { version: 1, entries: Array.from({ length: 10_000 }, (_, i) => ({ id: `s_${i}`, key: `kind ${i}`, label: `kind ${i}`, at: "2026-01-01T00:00:00.000Z" })) };
    const r = await b.engine.act({ id: o.id, action: "never" });
    assert.equal(r.ok, true);
    assert.equal(r.disabled, true);
    assert.equal(b.w.disabledCalls, 1);
    assert.equal(b.w.docs.supp.entries.length, 10_000, "no older promise was forgotten");
  });

  test("the box's labelling prompt is offered the suppressed kinds too, so the model keeps reusing the exact label", async () => {
    const { b, o } = await offered();
    await b.engine.act({ id: o.id, action: "never" });
    for (let i = 0; i < 80; i++) {
      b.w.labels[`U${i}`] = `do unrelated thing ${i}`;
      await handoff(b, `U${i}`);
    }
    assert.match(b.w.labelCalls.at(-1), /write release notes/);
  });
});

describe("limits (AC-4.5, AC-4.6)", () => {
  test("at most one offer per chat per day", async () => {
    const b = box({ labels: { A: "fix flaky test" } });
    await three(b);
    for (let i = 0; i < 3; i++) await handoff(b, "A");
    assert.equal((await offersOf(b)).length, 1, "same chat, same day");
    b.w.clock += DAY + 1000;
    await handoff(b, "A");
    assert.equal((await offersOf(b)).length, 2);
  });

  test("at most three per box per week, counted when created", async () => {
    const b = box();
    const chats = ["ses_a", "ses_b", "ses_c", "ses_d"];
    for (const [i, chat] of chats.entries()) {
      b.w.labels = { [`T${i}`]: `kind number ${i}` };
      for (let k = 0; k < 3; k++) await handoff(b, `T${i}`, { chat });
    }
    const total = b.w.docs.sugg.offers.length;
    assert.equal(total, 3, "the fourth chat had to wait");
    b.w.clock += 8 * DAY;
    await handoff(b, "T3", { chat: "ses_d" });
    assert.equal(b.w.docs.sugg.offers.length, 4);
  });

  test("the setting off: nothing is offered, but counting continues, so turning it on later works on recent history", async () => {
    const b = box({ enabled: false });
    await three(b);
    assert.equal((await offersOf(b)).length, 0);
    assert.equal(b.w.offerCalls.length, 0);
    b.w.enabled = true;
    await handoff(b, "Release notes for v4");
    assert.equal((await offersOf(b)).length, 1);
    assert.equal(b.w.docs.sugg.offers[0].count, 4);
  });
});

describe("wiring on the box (existing boxes converge with no manual step)", () => {
  const index = readFileSync(new URL("./index.mjs", import.meta.url), "utf-8");

  test("index.mjs builds the engine on the Summary-model one-shot, hands it to the agents engine and the rpc channels, recovers at boot and sweeps every minute", () => {
    assert.match(index, /const agentSuggestions = createAgentSuggestions\(/);
    assert.match(index, /summaryModel\.resolveCheapWriter\(sessionId\)/);
    assert.match(index, /createAgentsEngine\(\{\s*suggestions: agentSuggestions,/);
    assert.match(index, /buildHandlers\(\{\s*usageCalibration,\s*agents: agentsEngine,\s*suggestions: agentSuggestions,/);
    assert.match(index, /agentSuggestions\.recover\(\{ boot: true \}\)/);
    assert.match(index, /startPoller\(\(\) => agentSuggestions\.sweep\(\), \{ intervalMs: 60_000/);
  });

  test("the stores are created on first use under the agents folder, and the setting defaults to on when the key is absent", () => {
    assert.match(index, /statePath\("agents", "\.suggestions\.json"\)/);
    assert.match(index, /statePath\("agents", "\.suggestion-suppressions\.json"\)/);
    assert.match(index, /\?\.agentSuggestions !== false/);
  });
});
