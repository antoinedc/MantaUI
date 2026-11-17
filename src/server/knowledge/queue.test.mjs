import { test } from "node:test";
import assert from "node:assert/strict";
import { DEDUP_MS, createQueue, isValidRef, noteHash, validateNote, NoteRejected } from "./queue.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const SLUG = "alpha-0123456789";
const scanner = { redact: async (t) => ({ text: t.replace(/SECRETVALUE/g, "[REDACTED]"), redacted: /SECRETVALUE/.test(t) ? 1 : 0, unavailable: false }) };

async function rig(over = {}) {
  const state = await memState();
  const root = await tmpDir("knowledge-queue-");
  let t = 1_000_000;
  const drops = [];
  const q = createQueue({ state, scanner, root, now: () => t, onDrop: (slug, n) => drops.push([slug, n]), ...over });
  return { q, state, drops, advance: (ms) => (t += ms) };
}
const note = (over = {}) => ({ slug: SLUG, sessionID: "ses_1", origin: "tool", kind: "howto", text: "Run npm test", refs: ["msg:ses_1/msg_1"], ...over });

test("ref grammar (§11.4)", () => {
  for (const ok of ["msg:ses_1/msg_2", "part:ses_1/part_abcx0001", "commit:c4bbd906", "file:/home/dev/x.md", "pr:github.com/o/r#12", "url:https://example.com/a?b=1", "page:projects/x-0123456789/a.md"]) assert.equal(isValidRef(ok), true, ok);
  for (const bad of ["msg:ses_1", "commit:xyz", "file:relative/path", "url:http://insecure", "pr:o/r", "page:", "", 5, "javascript:alert(1)"]) assert.equal(isValidRef(bad), false, String(bad));
});

test("validateNote: kind, 1..400 chars, 1..8 valid refs for tool notes", () => {
  assert.throws(() => validateNote({ kind: "idea", text: "x", refs: ["commit:abcdef1"] }), NoteRejected);
  assert.throws(() => validateNote({ kind: "howto", text: "", refs: ["commit:abcdef1"] }), /text must be/);
  assert.throws(() => validateNote({ kind: "howto", text: "x".repeat(401), refs: ["commit:abcdef1"] }), /text must be/);
  assert.throws(() => validateNote({ kind: "howto", text: "x", refs: [] }), /refs must have/);
  assert.throws(() => validateNote({ kind: "howto", text: "x", refs: Array.from({ length: 9 }, (_, i) => `commit:abcdef${i}`) }), /refs must have/);
  assert.throws(() => validateNote({ kind: "howto", text: "x", refs: ["nonsense"] }), /Invalid ref/);
  assert.deepEqual(validateNote({ kind: "gotcha", text: "  a   b  ", refs: ["commit:abcdef1", "commit:abcdef1"] }), { kind: "gotcha", text: "a b", refs: ["commit:abcdef1"] });
  // other origins may carry no refs
  assert.equal(validateNote({ kind: "status", text: "x", refs: [] }, { origin: "cto" }).refs.length, 0);
});

test("enqueue writes one JSONL line per note with the pinned fields", async () => {
  const { q } = await rig();
  const r = await q.enqueue(note());
  assert.equal(r.accepted, true);
  assert.match(r.id, /^n_[0-9A-Z]{26}$/);
  const [n] = await q.list(SLUG);
  assert.deepEqual(Object.keys(n).sort(), ["at", "derived", "id", "kind", "origin", "refs", "sessionID", "slug", "text", "v"]);
  assert.equal(n.v, 1);
  assert.equal(n.derived, true); // no prompt-origin store wired → never user-authored
});

test("secrets are redacted on enqueue, before anything else sees the note", async () => {
  const { q } = await rig();
  const r = await q.enqueue(note({ text: "token is SECRETVALUE ok" }));
  assert.equal(r.redacted, true);
  assert.equal((await q.list(SLUG))[0].text, "token is [REDACTED] ok");
});

test("an unavailable scanner refuses the note", async () => {
  const { q } = await rig({ scanner: { redact: async () => ({ text: "", redacted: 0, unavailable: true }) } });
  const r = await q.enqueue(note());
  assert.equal(r.accepted, false);
  assert.equal(await q.count(SLUG), 0);
});

test("dedup: same kind + normalised text within 30 days, even after the note was consumed; expires after 30 days; kind matters", async () => {
  const { q, advance } = await rig();
  const first = await q.enqueue(note());
  assert.equal((await q.enqueue(note({ text: "  RUN   npm test " }))).accepted, false);
  assert.equal((await q.enqueue(note({ kind: "gotcha" }))).accepted, true);
  await q.consume(SLUG, [first.id]);
  assert.equal((await q.enqueue(note())).accepted, false); // consumed notes still dedup
  advance(DEDUP_MS + 1);
  assert.equal((await q.enqueue(note())).accepted, true);
  assert.notEqual(noteHash("howto", "a"), noteHash("gotcha", "a"));
});

test("bound: above 500 the oldest DERIVED notes go first, then the oldest of any kind; the drop is reported", async () => {
  const { q, drops } = await rig({ maxPending: 3 });
  const userAuthored = createQueue; // (marker to keep imports used)
  void userAuthored;
  await q.enqueue(note({ text: "one", derived: false }));
  await q.enqueue(note({ text: "two", derived: true }));
  await q.enqueue(note({ text: "three", derived: false }));
  await q.enqueue(note({ text: "four", derived: false })); // drops "two" (oldest derived)
  assert.deepEqual((await q.list(SLUG)).map((n) => n.text), ["one", "three", "four"]);
  await q.enqueue(note({ text: "five", derived: false })); // no derived left → oldest overall
  assert.deepEqual((await q.list(SLUG)).map((n) => n.text), ["three", "four", "five"]);
  assert.deepEqual(drops, [[SLUG, 1], [SLUG, 1]]);
});

test("a note is user-authored (not derived) when any ref resolves to a user message", async () => {
  const { q } = await rig({ isUserAuthoredRef: async (ref) => ref === "msg:ses_1/msg_user" });
  await q.enqueue(note({ text: "a", refs: ["msg:ses_1/msg_asst", "msg:ses_1/msg_user"] }));
  await q.enqueue(note({ text: "b", refs: ["msg:ses_1/msg_asst"] }));
  assert.deepEqual((await q.list(SLUG)).map((n) => n.derived), [false, true]);
});

test("stats, slugs and per-project files", async () => {
  const { q } = await rig();
  await q.enqueue(note({ text: "a" }));
  await q.enqueue(note({ slug: "beta-9876543210", text: "b" }));
  assert.deepEqual((await q.slugs()).sort(), [SLUG, "beta-9876543210"]);
  const st = await q.stats(SLUG);
  assert.equal(st.count, 1);
  assert.equal(st.lastAt, 1_000_000);
});

test("concurrent enqueues don't lose notes", async () => {
  const { q } = await rig();
  await Promise.all(Array.from({ length: 20 }, (_, i) => q.enqueue(note({ text: `n ${i}` }))));
  assert.equal(await q.count(SLUG), 20);
});
