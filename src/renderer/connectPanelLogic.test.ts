// connectPanelLogic.test.ts — deriveConnectPanel precedence-table tests (BET-961,
// BET-1007). One case per precedence row (11 rows), asserting tone / text /
// meta / progress / details.kind / log / actions, plus the invariants the
// BET-1007 acceptance gate calls out: rows where "nothing is happening" get a
// null status zone, no row carries a `hint`, and the log pane degrades to null
// over an empty body.

import { describe, it, expect } from "vitest";
import {
  deriveConnectPanel,
  type ConnectInput,
} from "./connectPanelLogic";

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
  claimError: null,
  cancelled: false,
  paired: false,
};

const status = (patch: Partial<Extract<ConnectInput, { mode: "ssh" }>>) => {
  const s = deriveConnectPanel({ ...base, ...patch });
  if (!s.status) return null;
  return { tone: s.status.tone, text: s.status.text, meta: s.status.meta };
};

describe("deriveConnectPanel — no row carries a `hint` (BET-1007)", () => {
  it("deletes the hint field from the state shape", () => {
    const rows = [
      deriveConnectPanel({ ...base, paired: true }),
      deriveConnectPanel({ ...base, preflightFailure: { failures: [] } }),
      deriveConnectPanel({ ...base, cancelled: true }),
      deriveConnectPanel({ ...base, claimError: "x" }),
      deriveConnectPanel({ ...base, installError: "x" }),
      deriveConnectPanel({ ...base, running: true }),
      deriveConnectPanel({ ...base, hostsLoaded: false }),
      deriveConnectPanel({ ...base, targetError: "x" }),
      deriveConnectPanel(base),
      deriveConnectPanel(manual({})),
      deriveConnectPanel(manual({ paired: true })),
    ];
    for (const state of rows) {
      expect(state).not.toHaveProperty("hint");
    }
  });
});

describe("deriveConnectPanel — precedence table (BET-961)", () => {
  it("row 1 — paired: 'Your server is ready' + progress 1 + next", () => {
    const s = deriveConnectPanel({
      ...base,
      paired: true,
      elapsedSeconds: 72,
      logLineCount: 2,
    });
    expect(status({ paired: true, elapsedSeconds: 72 })).toEqual({
      tone: "ok",
      text: "Your server is ready",
      meta: "6 of 6 · 1:12",
    });
    expect(s.status?.progress).toBe(1);
    expect(s.details.kind).toBe("none");
    expect(s.log).not.toBeNull();
    expect(s.actions).toEqual(["next"]);
  });

  it("row 2 — preflight failure: 'Couldn't reach the server' + failures, log null", () => {
    const s = deriveConnectPanel({
      ...base,
      stage: "preflight",
      preflightFailure: {
        failures: [{ cause: "SSH authentication failed", action: "Add your key" }],
      },
    });
    expect(status({ stage: "preflight", preflightFailure: { failures: [] } })).toEqual({
      tone: "error",
      text: "Couldn't reach the server",
      meta: "1 of 6",
    });
    expect(s.status?.progress).toBe(1 / 6);
    expect(s.details.kind).toBe("failures");
    if (s.details.kind === "failures") {
      expect(s.details.items[0].cause).toBe("SSH authentication failed");
    }
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["retry", "editTarget"]);
  });

  it("row 3 — cancelled: neutral tone + 'stopped at N of M', log pane", () => {
    const s = deriveConnectPanel({ ...base, cancelled: true, stage: "extract", logLineCount: 3 });
    expect(status({ cancelled: true, stage: "extract" })).toEqual({
      tone: "neutral",
      text: "Cancelled",
      meta: "stopped at 3 of 6",
    });
    expect(s.status?.progress).toBe(3 / 6);
    expect(s.details.kind).toBe("none");
    expect(s.log).not.toBeNull();
    expect(s.actions).toEqual(["install"]);
  });

  it("row 4 — claim error: surfaces the real error, log null", () => {
    const s = deriveConnectPanel({
      ...base,
      claimError: "Couldn't reach the server. Check the URL and try again.",
      stage: "pairing",
    });
    expect(status({ claimError: "x", stage: "pairing" })).toEqual({
      tone: "error",
      text: "Installed, but pairing didn't complete",
      meta: "5 of 6",
    });
    expect(s.status?.progress).toBe(5 / 6);
    expect(s.details.kind).toBe("hint");
    if (s.details.kind === "hint") {
      expect(s.details.text).toBe(
        "Couldn't reach the server. Check the URL and try again.",
      );
    }
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["pairManually", "retry"]);
  });

  it("row 5 — install failed: names stage + exit code; log opens with copy", () => {
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
    expect(s.details.kind).toBe("none");
    expect(s.log).not.toBeNull();
    expect(s.log?.defaultOpen).toBe(true);
    expect(s.log?.showCopyDiagnostics).toBe(true);
    expect(s.actions).toEqual(["retry", "pairManually"]);

    // code null → no "· exit …" suffix.
    const noCode = deriveConnectPanel({ ...base, installError: "boom", stage: "extract" });
    expect(noCode.status?.meta).toBe("3 of 6");
  });

  it("row 6 — awaiting prompt: 'Waiting for you' + cancel, details none, log null", () => {
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
    expect(s.status?.progress).toBe(4 / 6);
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["cancel"]);
  });

  it("row 7 — claim running: 'Pairing with this app', log pane auto-opens", () => {
    const s = deriveConnectPanel({
      ...base,
      claimRunning: true,
      stage: "pairing",
      elapsedSeconds: 53,
      logLineCount: 1,
    });
    expect(status({ claimRunning: true, stage: "pairing", elapsedSeconds: 53 })).toEqual({
      tone: "running",
      text: "Pairing with this app",
      meta: "5 of 6 · 0:53",
    });
    expect(s.status?.sub).toBeNull();
    expect(s.log?.defaultOpen).toBe(true);
    expect(s.actions).toEqual(["cancel"]);
  });

  it("row 8 — running: stage label + elapsed meta, zone A collapsed, log auto-opens", () => {
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
    expect(s.status?.progress).toBe(2 / 6);
    expect(s.details.kind).toBe("none");
    expect(s.log?.defaultOpen).toBe(true);
    expect(s.targetCollapsed).toBe(true);
    expect(s.actions).toEqual(["cancel"]);
  });

  it("row 9 — hosts not loaded: no status zone, disabled install", () => {
    const s = deriveConnectPanel({ ...base, hostsLoaded: false });
    expect(status({ hostsLoaded: false })).toBeNull();
    expect(s.status).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["install"]);
    expect(s.disabledActions).toEqual(["install"]);
  });

  it("row 10 — invalid target: no status zone, disabled install", () => {
    const s = deriveConnectPanel({ ...base, targetError: "Port must be a number" });
    expect(status({ targetError: "Port must be a number" })).toBeNull();
    expect(s.status).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["install"]);
    expect(s.disabledActions).toEqual(["install"]);
  });

  it("row 11 — ready: no status zone, install clickable (no disabledActions)", () => {
    const s = deriveConnectPanel(base);
    expect(status({})).toBeNull();
    expect(s.status).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["install"]);
    expect(s.disabledActions).toBeUndefined();
  });

  it("logPane degrades to null when there are no lines", () => {
    const s = deriveConnectPanel({ ...base, running: true, logLineCount: 0, stage: "service" });
    expect(s.log).toBeNull();
  });

  it("higher precedence beats lower — cancel beats done.ok === false", () => {
    const s = deriveConnectPanel({
      ...base,
      cancelled: true,
      done: { ok: false, code: null, signal: null },
    });
    expect(s.status?.text).toBe("Cancelled");
    expect(s.status?.tone).toBe("neutral");
  });

  it("higher precedence beats lower — paired beats an install error", () => {
    const s = deriveConnectPanel({ ...base, paired: true, installError: "boom" });
    expect(s.status?.text).toBe("Your server is ready");
    expect(s.status?.tone).toBe("ok");
    expect(s.actions).toEqual(["next"]);
  });

  it("targetCollapsed is true while running, claiming, or paired", () => {
    expect(deriveConnectPanel({ ...base, running: true }).targetCollapsed).toBe(true);
    expect(deriveConnectPanel({ ...base, claimRunning: true }).targetCollapsed).toBe(true);
    expect(deriveConnectPanel({ ...base, paired: true }).targetCollapsed).toBe(true);
    expect(deriveConnectPanel(base).targetCollapsed).toBe(false);
  });
});

// Manual mode (BET-962 / BET-1007) — one case per row in the issue's table.
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
  it("M1 — prefill present: no status zone + Connect/Discard", () => {
    const s = deriveConnectPanel(
      manual({ prefillPresent: true, canConnect: true }),
    );
    expect(s.status).toBeNull();
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["connect", "discard"]);
    expect(s.targetCollapsed).toBe(false);
  });

  it("M2 — idle manual: 'Enter the 6-digit code from the server' + hint; Connect disabled until canConnect", () => {
    const idle = deriveConnectPanel(manual({}));
    expect(idle.status).toEqual({
      tone: "idle",
      text: "Enter the 6-digit code from the server",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(idle.details).toEqual({
      kind: "hint",
      text: "Run `manta pair` on the server to get a code.",
    });
    expect(idle.log).toBeNull();
    expect(idle.actions).toEqual(["connect"]);
    expect(idle.disabledActions).toEqual(["connect"]);

    // canConnectSetup passes → Connect enabled (no disabledActions).
    const ready = deriveConnectPanel(manual({ canConnect: true }));
    expect(ready.disabledActions).toBeUndefined();
  });

  it("M3 — submitting: 'Pairing with this app' + cancel, zone A collapsed", () => {
    const s = deriveConnectPanel(manual({ submitting: true, canConnect: true }));
    expect(s.status).toEqual({
      tone: "running",
      text: "Pairing with this app",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["cancel"]);
    expect(s.targetCollapsed).toBe(true);
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
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["retry"]);
    expect(s.targetCollapsed).toBe(false);
  });

  it("M5 — claim succeeded: 'Your server is ready' + Next →, zone A collapsed", () => {
    const s = deriveConnectPanel(manual({ paired: true }));
    expect(s.status).toEqual({
      tone: "ok",
      text: "Your server is ready",
      meta: null,
      progress: null,
      sub: null,
    });
    expect(s.details.kind).toBe("none");
    expect(s.log).toBeNull();
    expect(s.actions).toEqual(["next"]);
    expect(s.targetCollapsed).toBe(true);
  });

  it("precedence — paired beats a claim error in manual mode", () => {
    const s = deriveConnectPanel(manual({ paired: true, claimError: "x" }));
    expect(s.status?.text).toBe("Your server is ready");
    expect(s.actions).toEqual(["next"]);
  });

  it("precedence — claim error and submitting beat prefill present", () => {
    expect(
      deriveConnectPanel(
        manual({ prefillPresent: true, claimError: "x" }),
      ).status?.text,
    ).toBe("x");
    expect(
      deriveConnectPanel(
        manual({ prefillPresent: true, submitting: true }),
      ).status?.text,
    ).toBe("Pairing with this app");
  });
});
