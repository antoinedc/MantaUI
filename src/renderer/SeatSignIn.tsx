// SeatSignIn — the sign-in pieces AddSeatFlow and ResignSeatFlow share.
//
// Both flows drive the SAME sign-in on the box (a Claude terminal + pasted code,
// or a device-code link) and differ only in what the box does with the finished
// login (file a new seat / re-sign an existing one). So everything that does not
// depend on that lives here once: the connect → sign-in shape, the block that
// renders it, the pending-Submit bookkeeping, the "sign-in exited with an error"
// watcher and the elapsed clock.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeatConnect } from "../shared/types";
import { formatRemaining } from "./chatUtils";
import { ClaudeLoginBlock, WaitingBlockBody } from "./ConnectProvider";
import { ProcessPanel } from "./ProcessPanel";

export const SEAT_POLL_INTERVAL_MS = 2_000;
// The box waits this long for a sign-in to finish (LOGIN_TIMEOUT_MS in
// src/server/accountsManager.mjs) — one limit for the Claude paste-back and the
// device-code wait alike. Keep the two in step.
export const SERVER_LOGIN_LIMIT_MS = 15 * 60 * 1_000;
// A card gives up only AFTER the box would have, plus a little slack for the
// clocks starting at slightly different moments.
export const CLIENT_LIMIT_MS = SERVER_LOGIN_LIMIT_MS + 30_000;

/** What a driveable sign-in looks like on screen. */
export type SignInPhase =
  | { kind: "claude"; sessionKey: string; cwd: string; url: string; inputError?: string }
  | { kind: "device"; url: string; instructions: string };

/** The box answers the SAME `connect` shape the existing flow does. Claude
 *  drives a terminal (`claude auth login`); the OAuth device flow shows a link +
 *  code. Anything else cannot be driven from here → null. */
export function signInFromConnect(c: SeatConnect): SignInPhase | null {
  if (c.shape === "claude-login" && typeof c.sessionKey === "string" && c.sessionKey) {
    return { kind: "claude", sessionKey: c.sessionKey, cwd: typeof c.cwd === "string" ? c.cwd : "~", url: "" };
  }
  if (c.shape === "oauth-auto") {
    return {
      kind: "device",
      url: typeof c.url === "string" ? c.url : "",
      instructions: typeof c.instructions === "string" ? c.instructions : "",
    };
  }
  return null;
}

/** Whole seconds since `key` became non-null (0 while null). */
export function useElapsedSeconds(key: string | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!key) return;
    const startedWall = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedWall) / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, [key]);
  return elapsed;
}

/** Submit keeps its spinner until the flow SETTLES (done / failed / asks /
 *  cancelled), not just until the code was typed into the sign-in. `wait()` is
 *  what Submit awaits; any phase other than an interactive "claude" one (or
 *  unmount) resolves it. */
export function useSubmitSettle(phase: { kind: string; inputError?: string }): () => Promise<void> {
  const settleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (phase.kind === "claude" && !phase.inputError) return;
    settleRef.current?.();
    settleRef.current = null;
  }, [phase]);
  useEffect(() => () => settleRef.current?.(), []);
  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        settleRef.current?.();
        settleRef.current = resolve;
      }),
    [],
  );
}

/** A sign-in terminal that EXITS with an error (a wrong or expired code) will
 *  never produce credentials: tell the flow now instead of leaving Submit
 *  spinning until the 15-minute deadline. A clean exit is a successful login —
 *  keep waiting for the box. */
export function useClaudeLoginExit(sessionKey: string | null, onFailedExit: () => void): void {
  const cbRef = useRef(onFailedExit);
  cbRef.current = onFailedExit;
  useEffect(() => {
    if (!sessionKey) return;
    return window.api.onPtyEvent((ev) => {
      if (ev.sessionKey !== sessionKey || ev.kind !== "exit" || ev.code === 0) return;
      cbRef.current();
    });
  }, [sessionKey]);
}

/** The sign-in UI itself — terminal + code paste, or the device-code block. */
export function SeatSignInBlock({
  phase,
  elapsed,
  waitForSettle,
  onPatch,
  onCancel,
}: {
  phase: SignInPhase;
  elapsed: number;
  waitForSettle: () => Promise<void>;
  /** The terminal found the sign-in URL / the code couldn't be written. */
  onPatch: (patch: { url?: string; inputError?: string | undefined }) => void;
  onCancel: () => void;
}) {
  if (phase.kind === "claude") {
    return (
      <ClaudeLoginBlock
        ptySessionKey={phase.sessionKey}
        cwd={phase.cwd}
        url={phase.url}
        preExisting={false}
        inputError={phase.inputError}
        onUrlDetected={(url) => onPatch({ url, inputError: undefined })}
        onSubmitCode={async (code) => {
          const trimmed = code.trim();
          if (!trimmed) return;
          try {
            await window.api.ptyWrite(phase.sessionKey, trimmed + "\r");
            if (phase.inputError) onPatch({ inputError: undefined });
          } catch {
            onPatch({ inputError: "Couldn't reach the server. Try again." });
            return;
          }
          // Stay "Saving…" until the box has settled the sign-in — the flow's
          // own poll drives the phase, which resolves this.
          await waitForSettle();
        }}
      />
    );
  }
  return (
    <ProcessPanel
      stages={["Waiting for sign-in"]}
      activeIndex={0}
      status="running"
      elapsedSeconds={elapsed}
      logLines={[]}
      remainingLabel={formatRemaining(0, elapsed * 1000, SERVER_LOGIN_LIMIT_MS)}
      onCancel={onCancel}
    >
      <WaitingBlockBody url={phase.url} instructions={phase.instructions} />
    </ProcessPanel>
  );
}
