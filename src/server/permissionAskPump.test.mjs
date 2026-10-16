import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldInterpretPermissionAsk,
  createAutoAnswerLedger,
  handlePermissionAsk,
} from "./permissionAskPump.mjs";
import { createStreamInterpreter } from "./streamInterp.mjs";

test("shouldInterpretPermissionAsk: only a successful trust-mode auto-reply skips interpretation", () => {
  assert.equal(shouldInterpretPermissionAsk({ autoAllow: true, replied: true }), false);
  assert.equal(shouldInterpretPermissionAsk({ autoAllow: true, replied: false }), true); // reply failed
  assert.equal(shouldInterpretPermissionAsk({ autoAllow: false, replied: false }), true); // trust off
  assert.equal(shouldInterpretPermissionAsk({ autoAllow: false, replied: true }), true); // impossible, but never skip
});

test("createAutoAnswerLedger: bounded, ignores non-string ids", () => {
  const l = createAutoAnswerLedger(4);
  l.add(undefined);
  l.add("");
  assert.equal(l.has(undefined), false);
  for (let i = 0; i < 20; i++) l.add(`p${i}`);
  assert.equal(l.has("p19"), true);
  assert.equal(l.has("p0"), false);
});

const ask = (id = "per_1") => ({ type: "permission.asked", id: `evt_${id}`, properties: { id, sessionID: "ses_a", permission: "bash" } });

function harness({ cfg = { chatAutoAllow: true }, cfgThrows = false, replyThrows = false, ledger = createAutoAnswerLedger() } = {}) {
  const log = [];
  return {
    log,
    run: (evt) =>
      handlePermissionAsk({
        evt,
        getConfig: async () => {
          if (cfgThrows) throw new Error("config unreadable");
          return cfg;
        },
        reply: async (a) => {
          log.push(["reply", a]);
          if (replyThrows) throw new Error("404");
        },
        interpret: (e) => log.push(["interpret", e.properties.id]),
        publish: (e) => log.push(["publish", e.properties.id]),
        push: (e) => log.push(["push", e.properties.id]),
        ledger,
      }),
  };
}

test("trust mode + auto-reply succeeds: replies, and NOTHING else (no frames, no raw event, no push)", async () => {
  const h = harness();
  await h.run(ask());
  assert.deepEqual(h.log, [["reply", { requestId: "per_1", reply: "always", sessionId: "ses_a" }]]);
});

test("trust mode off: interpret THEN publish THEN push; no reply", async () => {
  const h = harness({ cfg: { chatAutoAllow: false } });
  await h.run(ask());
  assert.deepEqual(h.log, [["interpret", "per_1"], ["publish", "per_1"], ["push", "per_1"]]);
});

test("config read fails: treated as trust off — interpret, publish, push", async () => {
  const h = harness({ cfgThrows: true });
  await h.run(ask());
  assert.deepEqual(h.log, [["interpret", "per_1"], ["publish", "per_1"], ["push", "per_1"]]);
});

test("trust mode but the auto-reply fails: the user must approve — interpret THEN publish, no push (as before)", async () => {
  const h = harness({ replyThrows: true });
  await h.run(ask());
  assert.deepEqual(h.log.map((l) => l[0]), ["reply", "interpret", "publish"]);
});

test("trust mode with no permission id: cannot auto-reply — interpret, publish, push", async () => {
  const h = harness();
  const evt = { type: "permission.asked", properties: { sessionID: "ses_a" } };
  await h.run({ ...evt, properties: { ...evt.properties, id: undefined } });
  assert.deepEqual(h.log.map((l) => l[0]), ["interpret", "publish", "push"]);
});

test("the duplicate delivery (global + scoped stream) is suppressed entirely — even when it overlaps the first", async () => {
  const ledger = createAutoAnswerLedger();
  const h = harness({ ledger });
  await Promise.all([h.run(ask()), h.run(ask())]);
  assert.deepEqual(h.log.map((l) => l[0]), ["reply"], "one reply, no frames, no raw publish");
});

test("integration with the real interpreter: an auto-answered ask publishes NO permissions/attention frame; a pending one does", async () => {
  const frames = [];
  const interp = createStreamInterpreter({ publish: (f) => frames.push(f), now: () => 1, setTimer: () => 0, clearTimer: () => {} });
  // V2: the pump hands the lifecycle form to its handler and interprets the RAW event.
  const raw = (id) => ({ type: "permission.asked", id: `evt_${id}`, data: { id, sessionID: "ses_a", action: "shell", resources: ["ls"], save: ["ls *"] } });
  const run = (cfg, evt) =>
    handlePermissionAsk({
      evt,
      getConfig: async () => cfg,
      reply: async () => {},
      interpret: () => interp.interpret(raw(evt.properties.id)),
      publish: () => {},
      push: () => {},
      ledger: createAutoAnswerLedger(),
    });
  await run({ chatAutoAllow: true }, ask("per_auto"));
  assert.equal(frames.filter((f) => f.sub === "permissions" || f.sub === "attention").length, 0);
  assert.equal(interp.snapshotState().filter((f) => f.sub === "attention").length, 0);
  await run({ chatAutoAllow: false }, ask("per_manual"));
  assert.deepEqual(frames.map((f) => f.sub), ["attention", "permissions"]);
  assert.deepEqual(frames[0].payload, { kind: "permission" });
});
