// connectPanel.test.ts — deriveConnectPanel precedence-table tests (BET-961).
//
// One case per precedence row (11 rows), asserting tone / text / meta /
// progress / details.kind / actions, plus the two invariants the acceptance
// gate calls out: logLineCount === 0 never yields a "log" details kind, and a
// higher-precedence row wins over a lower one (a user cancel beats a
// `done.ok === false`; a pair beats an install error).

import { describe, it, expect } from "vitest";
import {
  deriveConnectPanel,
  type ConnectInput,
} from "./connectPanel";

const base: ConnectInput = {
  mode: "ssh",
  hostsLoaded: true,
  targetError: null,
  running: false,
  stage: "preflight",
  elapsedSeconds: 0,
  logLineCount: 0,
  done: null,
  installError: null,
  preflightFailure: null,
  awaitingPrompt: false,
  claimRunning: false,
  claimElapsed: null,
  claimError: null,
  cancelled: false,
  paired: false,
};

const status = (patch: Partial<Extract<ConnectInput, { mode: "ssh" }>>) => {
  const s = deriveConnectPanel({ ...base, ...patch });
  return { tone: s.status.tone, text: s.status.text, meta: s.status.meta };
};

describe("deriveConnectPanel — precedence table (BET-961)", () => {
  it("row 1 — paired: 'Connected' + progress 1 + next action", () => {
    const s = deriveConnectPanel({
      ...base,
      paired: true,
      elapsedSeconds: 72,
      logLineCount: 2,
    });
    expect(status({ paired: true, elapsedSeconds: 72 })).toEqual({
      tone: "ok",
      text: "Connected — your box is ready",
      meta: "6 of 6 · 1:12",
    });
    expect(s.status.progress).toBe(1);
    expect(s.details.kind).toBe("log");
    expect(s.actions).toEqual(["next"]);
    expect(s.hint).toBe("next: connect a provider");
  });

  it("row 2 — preflight failure: 'Couldn't reach the box' + failures", () => {
    const s = deriveConnectPanel({
      ...base,
      stage: "preflight",
      preflightFailure: {
        failures: [{ cause: "SSH authentication failed", action: "Add your key" }],
      },
    });
    expect(status({ stage: "preflight", preflightFailure: { failures: [] } })).toEqual({
      tone: "error",
      text: "Couldn't reach the box",
      meta: "1 of 6",
    });
    expect(s.status.progress).toBe(1 / 6);
    expect(s.details.kind).toBe("failures");
    if (s.details.kind === "failures") {
      expect(s.details.items[0].cause).toBe("SSH authentication failed");
    }
    expect(s.actions).toEqual(["retry", "editTarget"]);
  });

  it("row 3 — cancelled: neutral tone + 'stopped at N of M'", () => {
    const s = deriveConnectPanel({ ...base, cancelled: true, stage: "extract", logLineCount: 3 });
    expect(status({ cancelled: true, stage: "extract" })).toEqual({
      tone: "neutral",
      text: "Cancelled",
      meta: "stopped at 3 of 6",
    });
    expect(s.status.progress).toBe(3 / 6);
    expect(s.details.kind).toBe("log");
    expect(s.actions).toEqual(["install"]);
  });

  it("row 4 — claim error: 'Installed, but pairing didn't complete' + hint", () => {
    const s = deriveConnectPanel({ ...base, claimError: "x", stage: "pairing" });
    expect(status({ claimError: "x", stage: "pairing" })).toEqual({
      tone: "error",
      text: "Installed, but pairing didn't complete",
      meta: "5 of 6",
    });
    expect(s.status.progress).toBe(5 / 6);
    expect(s.details.kind).toBe("hint");
    expect(s.actions).toEqual(["pairManually", "retry"]);
  });

  it("row 5 — install failed: names the stage + exit code; log auto-opens with copy", () => {
    const s = deriveConnectPanel({
      ...base,
      done: { ok: false, code: 1, signal: null },
      stage: "extract",
      logLineCount: 2,
    });
    expect(status({ done: { ok: false, code: 1, signal: null }, stage: "extract" })).toEqual({
      tone: "error",
      text: 'Install failed at “Installing files”',
      meta: "3 of 6 · exit 1",
    });
    expect(s.details.kind).toBe("log");
    if (s.details.kind === "log") {
      expect(s.details.defaultOpen).toBe(true);
      expect(s.details.showCopyDiagnostics).toBe(true);
    }
    expect(s.actions).toEqual(["retry", "pairManually"]);

    // code null → no "· exit …" suffix.
    const noCode = deriveConnectPanel({ ...base, installError: "boom", stage: "extract" });
    expect(noCode.status.meta).toBe("3 of 6");
  });

  it("row 6 — awaiting prompt: 'Waiting for you' + cancel, details none", () => {
    const s = deriveConnectPanel({
      ...base,
      awaitingPrompt: true,
      running: true,
      stage: "service",
      elapsedSeconds: 11,
    });
    expect(status({ awaitingPrompt: true, running: true, stage: "service", elapsedSeconds: 11 })).toEqual({
      tone: "attention",
      text: "Waiting for you",
      meta: "4 of 6 · 0:11",
    });
    expect(s.status.progress).toBe(4 / 6);
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["cancel"]);
  });

  it("row 7 — claim running: 'box is still starting' wording + retry substatus", () => {
    const s = deriveConnectPanel({
      ...base,
      claimRunning: true,
      claimElapsed: 5,
      stage: "pairing",
      elapsedSeconds: 53,
      logLineCount: 1,
    });
    expect(status({ claimRunning: true, claimElapsed: 5, stage: "pairing", elapsedSeconds: 53 })).toEqual({
      tone: "running",
      text: "Pairing — the box is still starting",
      meta: "5 of 6 · 0:53",
    });
    expect(s.status.sub).toBe("retrying every 2s · this is normal on a fresh install");
    expect(s.actions).toEqual(["cancel"]);

    // claimElapsed === 0 → plain "Pairing with this app", no substatus.
    const t0 = deriveConnectPanel({ ...base, claimRunning: true, claimElapsed: 0, stage: "pairing" });
    expect(t0.status.text).toBe("Pairing with this app");
    expect(t0.status.sub).toBeNull();
  });

  it("row 8 — running: stage label + elapsed meta", () => {
    const s = deriveConnectPanel({
      ...base,
      running: true,
      stage: "download",
      elapsedSeconds: 13,
      logLineCount: 1,
    });
    expect(status({ running: true, stage: "download", elapsedSeconds: 13 })).toEqual({
      tone: "running",
      text: "Download release",
      meta: "2 of 6 · 0:13",
    });
    expect(s.status.progress).toBe(2 / 6);
    expect(s.details.kind).toBe("log");
    expect(s.actions).toEqual(["cancel"]);
  });

  it("row 9 — hosts not loaded yet: disabled install", () => {
    const s = deriveConnectPanel({ ...base, hostsLoaded: false });
    expect(status({ hostsLoaded: false })).toEqual({
      tone: "idle",
      text: "Reading ~/.ssh/config…",
      meta: null,
    });
    expect(s.status.progress).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["install"]);
  });

  it("row 10 — invalid target: 'Check the highlighted field'", () => {
    const s = deriveConnectPanel({ ...base, targetError: "Port must be a number" });
    expect(status({ targetError: "Port must be a number" })).toEqual({
      tone: "attention",
      text: "Check the highlighted field",
      meta: null,
    });
    expect(s.status.progress).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["install"]);
  });

  it("row 11 — otherwise: ready to install, with the minute hint", () => {
    const s = deriveConnectPanel(base);
    expect(status({})).toEqual({
      tone: "idle",
      text: "Ready to install",
      meta: null,
    });
    expect(s.status.progress).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["install"]);
    expect(s.hint).toBe("takes about a minute");
  });

  it("logLineCount === 0 never yields a 'log' details kind", () => {
    const s = deriveConnectPanel({ ...base, running: true, logLineCount: 0, stage: "service" });
    expect(s.details.kind).not.toBe("log");
    expect(s.details.kind).toBe("none");
  });

  it("higher precedence beats lower — cancel beats done.ok === false", () => {
    const s = deriveConnectPanel({
      ...base,
      cancelled: true,
      done: { ok: false, code: null, signal: null },
    });
    expect(s.status.text).toBe("Cancelled");
    expect(s.status.tone).toBe("neutral");
  });

  it("higher precedence beats lower — paired beats an install error", () => {
    const s = deriveConnectPanel({ ...base, paired: true, installError: "boom" });
    expect(s.status.text).toBe("Connected — your box is ready");
    expect(s.status.tone).toBe("ok");
    expect(s.actions).toEqual(["next"]);
  });

  it("targetLocked is true while running, claiming, or paired", () => {
    expect(deriveConnectPanel({ ...base, running: true }).targetLocked).toBe(true);
    expect(deriveConnectPanel({ ...base, claimRunning: true }).targetLocked).toBe(true);
    expect(deriveConnectPanel({ ...base, paired: true }).targetLocked).toBe(true);
    expect(deriveConnectPanel(base).targetLocked).toBe(false);
  });
});

// Manual mode (BET-962) — one case per row in the issue's table.
function manual(patch: Partial<ConnectInput>): ConnectInput {
  return {
    mode: "manual",
    claimError: null,
    paired: false,
    prefillPresent: false,
    canConnect: false,
    submitting: false,
    ...patch,
  } as ConnectInput;
}

describe("deriveConnectPanel — manual mode rows (BET-962)", () => {
  it("M1 — prefill present: 'Pairing link ready' + Connect/Discard", () => {
    const s = deriveConnectPanel(
      manual({ prefillPresent: true, canConnect: true }),
    );
    expect(s.status).toEqual({
      tone: "idle",
      text: "Pairing link ready",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["connect", "discard"]);
    expect(s.hint).toBeNull();
    expect(s.targetLocked).toBe(false);
  });

  it("M2 — idle manual: 'Enter the 6-digit code from the box' + hint; Connect disabled until canConnect", () => {
    const idle = deriveConnectPanel(manual({}));
    expect(idle.status).toEqual({
      tone: "idle",
      text: "Enter the 6-digit code from the box",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(idle.details).toEqual({
      kind: "hint",
      text: "Run `manta pair` on the box to get a code.",
    });
    expect(idle.actions).toEqual(["connect"]);
    expect(idle.disabledActions).toEqual(["connect"]);

    // canConnectSetup passes → Connect enabled (no disabledActions).
    const ready = deriveConnectPanel(manual({ canConnect: true }));
    expect(ready.disabledActions).toBeUndefined();
  });

  it("M3 — submitting: 'Pairing with this app' + cancel, zone A locked", () => {
    const s = deriveConnectPanel(manual({ submitting: true, canConnect: true }));
    expect(s.status).toEqual({
      tone: "running",
      text: "Pairing with this app",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["cancel"]);
    expect(s.targetLocked).toBe(true);
  });

  it("M4 — claim failed: the message claimBox returned + Try again", () => {
    const s = deriveConnectPanel(manual({ claimError: "Claim failed: nope" }));
    expect(s.status).toEqual({
      tone: "error",
      text: "Claim failed: nope",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["retry"]);
    expect(s.targetLocked).toBe(false);
  });

  it("M5 — claim succeeded: 'Connected — your box is ready' + Next → (same ending as SSH)", () => {
    const s = deriveConnectPanel(manual({ paired: true }));
    expect(s.status).toEqual({
      tone: "ok",
      text: "Connected — your box is ready",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.actions).toEqual(["next"]);
    expect(s.targetLocked).toBe(true);
  });

  it("precedence — paired beats a claim error in manual mode", () => {
    const s = deriveConnectPanel(manual({ paired: true, claimError: "x" }));
    expect(s.status.text).toBe("Connected — your box is ready");
    expect(s.actions).toEqual(["next"]);
  });

  it("precedence — claim error and submitting beat prefill present", () => {
    expect(
      deriveConnectPanel(
        manual({ prefillPresent: true, claimError: "x" }),
      ).status.text,
    ).toBe("x");
    expect(
      deriveConnectPanel(
        manual({ prefillPresent: true, submitting: true }),
      ).status.text,
    ).toBe("Pairing with this app");
  });
});
