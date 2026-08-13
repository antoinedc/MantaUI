// ConnectProvider.tsx — subscription-provider connect card (BET-312, BET-354).
//
// The single shared connect-flow component for Codex, Kimi, and Claude
// (in-app, OAuth device flow / API-key paste). Consumed by stage 3 from both
// the Settings card (BET-314) and the onboarding rewrite (BET-315); this
// file is the only implementation, and it intentionally does nothing else.
//
// State machine — exactly the transitions the issue calls for, no extras:
//
//   mount -> starting -> (waiting | needsCode | needsKey | needsClaudeLogin)
//          -> applying -> done | failed
//
//   waiting           device-code OAuth (Codex). Shows URL + instructions + a
//                     copyable code; polls status until connected or 5 min.
//   needsCode         paste-back OAuth (browser variant, deliberately never
//                     selected by the server's resolveAuthMethod). Same UX as
//                     waiting, but no poll — the user submits the code.
//   needsKey          API-key path (Kimi, plus the fallback when
//                     resolveAuthMethod returns null). One password input +
//                     optional "Get a key" link to the registry-supplied
//                     console URL.
//   needsClaudeLogin  (BET-354) Claude's in-app connect. The server has
//                     spawned `claude auth login` on the box and returned
//                     a sessionKey the renderer mounts a Terminal pane
//                     for. The renderer polls claude-status (1s tick)
//                     until the credentials file appears (or
//                     "pre-existing" — the user already had a working
//                     login), then transitions to `applying`.
//   applying          restart + 30s poll. The restart fires immediately;
//                     the panel-level restart banner (BET-420) is cleared
//                     via useStore on success. The Claude path sets
//                     phase.restarted=true (the server already restarted
//                     as part of pollClaudeLogin) so this effect skips
//                     its own restart — a third back-to-back restart
//                     would flap systemd.
//
// Pure helpers (connectPhaseLabel, parseDeviceCode, isPollExpired) live in
// chatUtils.ts so every "what does this phase mean?" / "has the poll
// expired?" decision pins against a unit test. This file is intentionally
// close to render-only: the state machine, polling effects, and one input
// component are the only non-render code.
//
// No provider id, label, or console URL is hardcoded here — all of it
// arrives via props (id, label) or the `status` action (console). See the
// server-side SUBSCRIPTION_PROVIDERS table in subscriptionProviders.mjs.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { OpencodeProviderAuthRequest } from "../shared/types";
import {
  connectPhaseLabel,
  deviceCodeFallback,
  formatRemaining,
  isPollExpired,
  parseDeviceCode,
  type ConnectPhase,
} from "./chatUtils";
import { CopyButton } from "./CopyButton";
import { Terminal } from "./Terminal";
import { useStore } from "./store";
import { ProcessPanel } from "./ProcessPanel";
import { Callout } from "./Callout";

// Poll cadences (BET-312, BET-354): 3s for both the device-code wait and
// the post-restart readiness poll. BET-354 adds a 1s tick for the
// Claude-login progress poll (file mtime is cheap to read at 1Hz and
// the user wants to see the card flip promptly when the OAuth completes).
// The caps (5 min / 30 s / 5 min) are intentionally separate and live as
// constants here so a future tuning pass touches one place, not three.
const DEVICE_POLL_INTERVAL_MS = 3_000;
const DEVICE_POLL_LIMIT_MS = 5 * 60 * 1_000;
const RESTART_POLL_INTERVAL_MS = 3_000;
const RESTART_POLL_LIMIT_MS = 30_000;
const CLAUDE_POLL_INTERVAL_MS = 1_000;
const CLAUDE_POLL_LIMIT_MS = 5 * 60 * 1_000;
// BET-421 §E: lazy Claude CLI install poll. The installer writes the binary
// to ~/.local/bin/claude; we poll opencodeClaudeCliStatus() until it appears.
const CLAUDE_INSTALL_POLL_INTERVAL_MS = 2_000;
const CLAUDE_INSTALL_POLL_LIMIT_MS = 5 * 60 * 1_000;

// Track the in-flight action so an unmounted / unmounting component cannot
// call setPhase on an unmounted tree (React's "set state on unmounted
// component" warning, harmless but noisy in tests). One ref covers every
// async path; transitions into a terminal state (`done` / `failed`) and the
// cleanup at unmount both flip it.
function useMounted() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export function ConnectProvider({
  id,
  label,
  onDone,
  onCancel,
}: {
  id: string;
  label: string;
  onDone: (connected: boolean) => void;
  onCancel: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<ConnectPhase>({ kind: "starting" });
  // Bumped by retry() to re-run the `{action:"start"}` effect below — the
  // effect's other deps (id, safeSetPhase) are stable, so without this the
  // Retry button dead-ends on every failure path until the card remounts.
  const [startEpoch, setStartEpoch] = useState(0);
  // BET-421 §A/§D: elapsed timers for the phases that render a ProcessPanel.
  // Each ticks once a second while its phase is active; reset to 0 on exit.
  const [waitingElapsed, setWaitingElapsed] = useState(0);
  const [applyingElapsed, setApplyingElapsed] = useState(0);
  const [installElapsed, setInstallElapsed] = useState(0);
  const waitingStartedRef = useRef<number>(0);
  const applyingStartedRef = useRef<number>(0);
  const installStartedRef = useRef<number>(0);

  useEffect(() => {
    if (phase.kind !== "waiting") {
      setWaitingElapsed(0);
      return;
    }
    waitingStartedRef.current = Date.now();
    setWaitingElapsed(0);
    const t = setInterval(() => {
      setWaitingElapsed(Math.floor((Date.now() - waitingStartedRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase.kind, phase.kind === "waiting" ? phase.methodIndex : null]);

  useEffect(() => {
    if (phase.kind !== "applying") {
      setApplyingElapsed(0);
      return;
    }
    applyingStartedRef.current = Date.now();
    setApplyingElapsed(0);
    const t = setInterval(() => {
      setApplyingElapsed(Math.floor((Date.now() - applyingStartedRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase.kind, phase.kind === "applying" ? phase.restartConfirmed : null, phase.kind === "applying" ? phase.restarted : null]);

  useEffect(() => {
    if (phase.kind !== "installingClaudeCli") {
      setInstallElapsed(0);
      return;
    }
    installStartedRef.current = Date.now();
    setInstallElapsed(0);
    const t = setInterval(() => {
      setInstallElapsed(Math.floor((Date.now() - installStartedRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase.kind, phase.kind === "installingClaudeCli" ? phase.ptySessionKey : null]);

  const mounted = useMounted();

  // Wraps setPhase to guard against late-firing async paths (status polls,
  // restart callbacks) that may complete after the parent has unmounted the
  // card — e.g. the user hit Retry and immediately closed the Settings tab.
  const safeSetPhase = useCallback(
    (next: ConnectPhase) => {
      if (mounted.current) setPhase(next);
    },
    [mounted],
  );

  // Fire `{action:"start"}` on mount. The server's resolveAuthMethod picks
  // the right opencode method index (NEVER a literal) and returns one of
  // four shapes that drive the next state directly. Errors fall back to
  // the API-key path so a transient box-unreachable still gives the user a
  // way forward.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const req: OpencodeProviderAuthRequest = { action: "start", id };
      let res;
      try {
        res = await window.api.opencodeProviderAuth(req);
      } catch {
        if (!cancelled) safeSetPhase({ kind: "failed", message: "Couldn't reach the box. Try again." });
        return;
      }
      if (cancelled) return;
      if (res.action !== "start") {
        safeSetPhase({ kind: "failed", message: "Unexpected response from the box." });
        return;
      }
      // BET-354: claude-login shape carries a sessionKey for the live
      // terminal pane + the server-side startedAt timestamp the renderer
      // passes back to the claude-status poll. The server has already
      // stamped the metadata; the actual pty:spawn is below (in the
      // Terminal's own useEffect) so the IPty sizes to the rendered
      // cols/rows rather than a fixed 80x24.
      if (res.shape === "claude-login") {
        // BET-421 §E: before entering sign-in, probe whether the `claude`
        // CLI is actually on the box. install.sh no longer installs it; the
        // app owns it now. If the binary is missing, transition to
        // `installingClaudeCli` instead of `needsClaudeLogin` — spawning
        // `claude auth login` against a missing binary would ENOENT. The
        // server-side sessionKey is preserved for reuse after install
        // (startClaudeLogin only stamps metadata; it doesn't spawn).
        const sessionKey = typeof res.sessionKey === "string" ? res.sessionKey : "";
        const startedAt = typeof res.startedAt === "number" ? res.startedAt : Date.now();
        const cwd = typeof res.cwd === "string" ? res.cwd : "~";
        try {
          const status = await window.api.opencodeClaudeCliStatus();
          if (cancelled) return;
          if (status && !status.installed) {
            // Generate a client-side pty session key for the installer.
            // The Terminal's pty:spawn registers it; we kill it on success.
            const installKey = `claude-install-${Date.now()}`;
            safeSetPhase({
              kind: "installingClaudeCli",
              ptySessionKey: installKey,
              loginSessionKey: sessionKey,
              startedAt,
              cwd,
            });
            return;
          }
        } catch {
          // Probe failed (box unreachable, etc.) — fall through to the
          // normal sign-in path. If the binary really is missing, the
          // claude auth login spawn will ENOENT and the claude-status
          // poll will timeout, surfacing a normal failure. Better to try
          // than to block the whole flow on a probe failure.
        }
        safeSetPhase({
          kind: "needsClaudeLogin",
          ptySessionKey: sessionKey,
          startedAt,
          cwd,
          url: "",
          inputError: undefined,
          preExisting: false,
        });
        return;
      }
      if (res.shape === "oauth-auto") {
        safeSetPhase({
          kind: "waiting",
          url: typeof res.url === "string" ? res.url : "",
          instructions: typeof res.instructions === "string" ? res.instructions : "",
          methodIndex: typeof res.methodIndex === "number" ? res.methodIndex : 0,
        });
        return;
      }
      if (res.shape === "oauth-code") {
        safeSetPhase({
          kind: "needsCode",
          url: typeof res.url === "string" ? res.url : "",
          instructions: typeof res.instructions === "string" ? res.instructions : "",
          methodIndex: typeof res.methodIndex === "number" ? res.methodIndex : 0,
        });
        return;
      }
      // api-key path. Fetch the console URL from the status action so the
      // "Get a key" link can appear when the registry provides one; the
      // start response itself doesn't carry it (server-side scope: the
      // resolver returns the connect shape, not the meta).
      let consoleUrl: string | null = null;
      try {
        const s = await window.api.opencodeProviderAuth({ action: "status" });
        if (s.action === "status") {
          const row = s.providers.find((p) => p.id === id);
          consoleUrl = row?.console ?? null;
        }
      } catch {
        // Console link is optional; degrade silently to "no link".
      }
      safeSetPhase({ kind: "needsKey", consoleUrl });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, safeSetPhase, startEpoch]);

  // BET-354: claude-status poll. Fires every 1s while `needsClaudeLogin`.
  // The server checks the credentials file mtime + probes opencode's
  // `connected[]`. We advance to `applying` on `completed` (the server
  // has already called restartOpencode + verified connected[], so the
  // `applying` effect skips its own restart — `restarted: true`).
  // `pre-existing` advances to `applying` too: the user had a working
  // login, the server did NOT restart (no fresh credentials to
  // apply), and the standard 30s connected[] poll resolves the flow
  // either to `done` (anthropic already online) or to the existing
  // 30s-cap `failed` ("provider didn't come online"). `no-file` keeps
  // polling. 5-minute hard cap matches the device-code cap (same
  // rationale: an unbounded poll would leave the user staring at a
  // stale UI forever).
  useEffect(() => {
    if (phase.kind !== "needsClaudeLogin") return;
    const startedAt = phase.startedAt;
    const sessionKey = phase.ptySessionKey;
    const startedWall = Date.now();
    const handle = window.setInterval(async () => {
      if (!mounted.current) return;
      if (isPollExpired(startedWall, Date.now(), CLAUDE_POLL_LIMIT_MS)) {
        window.clearInterval(handle);
        safeSetPhase({
          kind: "failed",
          message:
            "The Claude sign-in didn't complete in time. Try again.",
        });
        return;
      }
      try {
        const res = await window.api.opencodeProviderAuth({
          action: "claude-status",
          sessionKey,
          startedAt,
        });
        if (!mounted.current) return;
        if (res.action !== "claude-status" || !res.ok) return;
        const p = res.progress;
        if (!p) return;
        if (p.state === "completed") {
          // Server already called restartOpencode + probed connected[];
          // tell the `applying` effect to skip its own restart so we
          // don't flap opencode-serve a third time on the same flow.
          window.clearInterval(handle);
          safeSetPhase({
            kind: "applying",
            restartConfirmed: true,
            restarted: true,
          });
          return;
        }
        if (p.state === "pre-existing") {
          // Credentials file predates this connect flow. The user
          // already had a working login; advance to the standard
          // `applying` flow which polls connected[] (and only
          // restarts if anthropic isn't there — restart is gated on
          // the existing confirm bar in Settings).
          window.clearInterval(handle);
          safeSetPhase({
            kind: "applying",
            restartConfirmed: false,
          });
          return;
        }
      } catch {
        /* keep polling; box may be transiently unreachable */
      }
    }, CLAUDE_POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [phase, safeSetPhase, mounted]);

  // BET-421 §E: lazy Claude CLI install poll. While `installingClaudeCli`,
  // poll opencodeClaudeCliStatus() every 2s. When the binary appears on
  // disk, kill the installer pty and re-fire `{action:"start"}` to enter
  // `needsClaudeLogin` with the SAME server-side sessionKey. Hard cap 5 min
  // — same rationale as the device-code cap. A pty-exit with no binary is
  // an installer failure → surface the failure card with three actions.
  useEffect(() => {
    if (phase.kind !== "installingClaudeCli") return;
    const installKey = phase.ptySessionKey;
    const loginKey = phase.loginSessionKey;
    const startedAt = phase.startedAt;
    const cwd = phase.cwd;
    const startedWall = Date.now();
    let exited = false;

    // Listen for the installer pty exiting — if it exits and the binary
    // still isn't installed, that's a failure (curl failed, bash errored,
    // etc.). The Terminal owns the IPty; we just watch the event bus.
    const dispose = window.api.onPtyEvent((ev) => {
      if (ev.sessionKey !== installKey) return;
      if (ev.kind === "exit") exited = true;
    });

    const handle = window.setInterval(async () => {
      if (!mounted.current) return;
      if (isPollExpired(startedWall, Date.now(), CLAUDE_INSTALL_POLL_LIMIT_MS)) {
        window.clearInterval(handle);
        dispose();
        try { await window.api.ptyKill(installKey); } catch { /* best-effort */ }
        safeSetPhase({
          kind: "failed",
          reason: "claude-cli-install",
          message:
            "The Claude CLI didn't install in time. The box itself is fine — try again, use a different model, or install it manually.",
        });
        return;
      }
      try {
        const status = await window.api.opencodeClaudeCliStatus();
        if (!mounted.current) return;
        if (status && status.installed) {
          window.clearInterval(handle);
          dispose();
          try { await window.api.ptyKill(installKey); } catch { /* best-effort */ }
          // Binary is on disk → re-enter the normal sign-in flow using
          // the server-side sessionKey we already minted.
          safeSetPhase({
            kind: "needsClaudeLogin",
            ptySessionKey: loginKey,
            startedAt,
            cwd,
            url: "",
            inputError: undefined,
            preExisting: false,
          });
          return;
        }
        // pty exited but binary still not found → installer failed.
        if (exited) {
          window.clearInterval(handle);
          dispose();
          safeSetPhase({
            kind: "failed",
            reason: "claude-cli-install",
            message:
              "The Claude CLI installer exited without installing the binary. The box itself is fine — try again, use a different model, or install it manually from https://claude.ai.",
          });
          return;
        }
      } catch {
        /* keep polling; box may be transiently unreachable */
      }
    }, CLAUDE_INSTALL_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
      dispose();
    };
  }, [phase, safeSetPhase, mounted]);

  // Device-code poll (waiting). Polls `{action:"status"}` every 3s; the
  // provider-id appearing in `connected[]` is the success signal (opencode
  // has acknowledged the OAuth callback). Hard cap of 5 minutes — device
  // codes do expire, and an unbounded poll would leave the user staring at
  // a dead code. Cleanup runs on every phase change AND on unmount, so the
  // interval is freed as soon as we leave `waiting`.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const startedAt = Date.now();
    const handle = window.setInterval(async () => {
      if (isPollExpired(startedAt, Date.now(), DEVICE_POLL_LIMIT_MS)) {
        window.clearInterval(handle);
        safeSetPhase({ kind: "failed", message: "The sign-in code expired. Try again." });
        return;
      }
      try {
        const res = await window.api.opencodeProviderAuth({ action: "status" });
        if (
          res.action === "status" &&
          res.providers.some((p) => p.id === id && p.connected)
        ) {
          window.clearInterval(handle);
          safeSetPhase({ kind: "applying", restartConfirmed: false });
        }
      } catch {
        /* keep polling; box may be transiently unreachable */
      }
    }, DEVICE_POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [phase.kind, id, safeSetPhase]);

  // Restart + readiness poll (applying). The restart fires immediately
  // and the 30s poll drives the transition to `done` / `failed`. The 30s
  // poll drives the transition to `done` / `failed`. The 30s cap is what
  // catches a mistyped API key: the write succeeds, but the re-read is the
  // only proof the credential is real.
  //
  // BET-354 (Block #3): when phase.restarted is true (the Claude
  // "completed" path), the server already called restartOpencode as
  // part of pollClaudeLogin. Skipping the renderer's restart here is
  // load-bearing — opencode-serve restarts drop every in-flight
  // opencode turn across the box, and a third back-to-back restart on
  // the same flow flaps systemd and (worse) destroys any user-visible
  // progress that completed before the second restart.
  useEffect(() => {
    if (phase.kind !== "applying") return;
    let cancelled = false;
    const startedAt = Date.now();
    const serverAlreadyRestarted = phase.restarted === true;
    (async () => {
      if (!serverAlreadyRestarted) {
        try {
          await window.api.opencodeRestart();
          // BET-420: this restart satisfies any pending panel-level restart
          // banner — clear it so the banner doesn't outlive the restart.
          useStore.getState().setOpencodeRestartNeeded(false);
        } catch {
          /* poll below will catch a no-op restart on a reachable box */
        }
      }
      if (cancelled) return;
      const tick = async () => {
        if (cancelled) return;
        if (isPollExpired(startedAt, Date.now(), RESTART_POLL_LIMIT_MS)) {
          safeSetPhase({
            kind: "failed",
            message:
              "Saved, but the provider didn't come online. Check the credential and try again.",
          });
          return;
        }
        try {
          const res = await window.api.opencodeProviderAuth({ action: "status" });
          if (
            res.action === "status" &&
            res.providers.some((p) => p.id === id && p.connected)
          ) {
            safeSetPhase({ kind: "done" });
            return;
          }
        } catch {
          /* keep polling */
        }
        window.setTimeout(tick, RESTART_POLL_INTERVAL_MS);
      };
      window.setTimeout(tick, RESTART_POLL_INTERVAL_MS);
    })();
    return () => {
      cancelled = true;
    };
    // `phase.restartConfirmed` / `phase.restarted` only exist on the
    // `applying` variant; the ternary narrows `phase` for the access and
    // the `null` branch keeps the deps array a uniform value list (the
    // false branches never read the field).
  }, [phase.kind, phase.kind === "applying" ? phase.restartConfirmed : null, phase.kind === "applying" ? phase.restarted : null, id, safeSetPhase]);

  // done is terminal — fire onDone exactly once when the phase KIND
  // becomes "done". Deps `[phase.kind, onDone]` so updates to fields
  // within the same kind (e.g. inputError) do not re-fire onDone.
  //
  // Claude-login teardown (server-side metadata) is handled by the
  // ClaudeLoginBlock's own unmount cleanup (its useEffect on
  // ptySessionKey), which calls claudeLoginCancel when ClaudeLoginBlock
  // unmounts. We deliberately do NOT call cancelClaudeLoginSession
  // here — earlier this effect fired on entry to needsClaudeLogin and
  // cancelled the just-minted server session, breaking every
  // subsequent claude-status poll (server returned unknown_session and
  // the flow never advanced; BET-354 cycle-2 Block #1).
  useEffect(() => {
    if (phase.kind !== "done") return;
    onDone(true);
  }, [phase.kind, onDone]);

  const retry = useCallback(() => {
    setStartEpoch((e) => e + 1);
    safeSetPhase({ kind: "starting" });
  }, [safeSetPhase]);

  return (
    <div className="rounded-sm border bg-bg-elev px-3 py-2 text-meta space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-text">Connect {label}</span>
        <span className="text-text-faint">{connectPhaseLabel(phase)}</span>
        <button
          onClick={onCancel}
          className="ml-auto px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close"
          aria-label="Close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {phase.kind === "starting" && (
        <div className="text-text-muted">Preparing sign-in…</div>
      )}

      {phase.kind === "waiting" && (
        <ProcessPanel
          stages={["Waiting for sign-in"]}
          activeIndex={0}
          status="running"
          elapsedSeconds={waitingElapsed}
          logLines={[]}
          remainingLabel={formatRemaining(0, waitingElapsed * 1000, DEVICE_POLL_LIMIT_MS)}
          onCancel={onCancel}
        >
          <WaitingBlockBody
            url={phase.url}
            instructions={phase.instructions}
          />
        </ProcessPanel>
      )}

      {phase.kind === "needsCode" && (
        <CredentialInput
          label="Code from the page"
          type="text"
          placeholder="paste the code"
          submitLabel="Submit"
          error={phase.inputError}
          onSubmit={async (code) => {
            let res;
            try {
              res = await window.api.opencodeProviderAuth({
                action: "code",
                id,
                methodIndex: phase.methodIndex,
                code,
              });
            } catch {
              safeSetPhase({
                kind: "needsCode",
                url: phase.url,
                instructions: phase.instructions,
                methodIndex: phase.methodIndex,
                inputError: "Couldn't reach the box. Try again.",
              });
              return;
            }
            if (res.action !== "code") return;
            if (res.ok) {
              safeSetPhase({ kind: "applying", restartConfirmed: false });
              return;
            }
            safeSetPhase({
              kind: "needsCode",
              url: phase.url,
              instructions: phase.instructions,
              methodIndex: phase.methodIndex,
              inputError:
                res.error === "unauthorized"
                  ? "That code didn't work. Try again."
                  : `Sign-in failed: ${res.error ?? "unknown"}`,
            });
          }}
        />
      )}

      {phase.kind === "needsKey" && (
        <div className="space-y-2">
          {phase.consoleUrl && (
            <a
              href={phase.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted underline decoration-dotted text-label"
            >
              Get a key
            </a>
          )}
          <CredentialInput
            label="API key"
            type="password"
            placeholder="paste your API key"
            submitLabel="Save"
            error={phase.inputError}
            onSubmit={async (key) => {
              let res;
              try {
                res = await window.api.opencodeProviderAuth({
                  action: "key",
                  id,
                  key,
                });
              } catch {
                safeSetPhase({
                  kind: "needsKey",
                  consoleUrl: phase.consoleUrl,
                  inputError: "Couldn't reach the box. Try again.",
                });
                return;
              }
              if (res.action !== "key") return;
              if (res.ok) {
                safeSetPhase({ kind: "applying", restartConfirmed: false });
                return;
              }
              safeSetPhase({
                kind: "needsKey",
                consoleUrl: phase.consoleUrl,
                inputError:
                  res.error === "unauthorized"
                    ? "That key didn't work. Try again."
                    : `Save failed: ${res.error ?? "unknown"}`,
              });
            }}
          />
        </div>
      )}

      {/* BET-354: in-app Claude connect. Mounts a Terminal pane for the
          spawned `claude auth login` so the user can see what the box is
          doing (raw escape sequences render through xterm — the existing
          Terminal component is reused, NOT a <pre>, per the POC's
          recommendation). Above the terminal: a clickable URL extracted
          from the live stream + a code input that feeds back through
          pty:write. */}
      {phase.kind === "needsClaudeLogin" && (
        <ClaudeLoginBlock
          ptySessionKey={phase.ptySessionKey}
          cwd={phase.cwd}
          url={phase.url}
          preExisting={phase.preExisting ?? false}
          inputError={phase.inputError}
          onUrlDetected={(url) =>
            safeSetPhase({ ...phase, url, inputError: undefined })
          }
          onSubmitCode={async (code) => {
            // Feed the code back through the existing pty bus. The
            // server has already attached a sessionKey to a live
            // `claude auth login` process, so the write reaches the
            // child directly. CR submits (verified by the BET-352 POC).
            const trimmed = code.trim();
            if (!trimmed) return;
            try {
              await window.api.ptyWrite(phase.ptySessionKey, trimmed + "\r");
            } catch {
              safeSetPhase({
                ...phase,
                inputError: "Couldn't reach the box. Try again.",
              });
              return;
            }
            // Clear any prior input error on a successful write. The
            // claude-status poll will surface a real auth failure (no
            // mtime advance after the next tick).
            if (phase.inputError) {
              safeSetPhase({ ...phase, inputError: undefined });
            }
          }}
        />
      )}

      {phase.kind === "installingClaudeCli" && (
        <ProcessPanel
          stages={["Installing the Claude CLI"]}
          activeIndex={0}
          status="running"
          elapsedSeconds={installElapsed}
          logLines={[]}
          remainingLabel={formatRemaining(0, installElapsed * 1000, CLAUDE_INSTALL_POLL_LIMIT_MS)}
          onCancel={onCancel}
        >
          <div className="space-y-2">
            <p className="text-text-muted">
              The <b className="text-text">claude</b> CLI isn't on this box yet.
              Installing it now via the official installer — no action needed.
            </p>
            <details className="text-meta">
              <summary className="text-text-faint cursor-pointer hover:text-text-muted">
                Show what's happening on the box
              </summary>
              <div className="rounded-xs border border-border overflow-hidden h-40 bg-[var(--inset)] mt-1">
                <Terminal
                  sessionKey={phase.ptySessionKey}
                  cwd={phase.cwd}
                  active={true}
                  launcher={{ id: "claude-cli-install", flags: {} }}
                />
              </div>
            </details>
          </div>
        </ProcessPanel>
      )}

      {phase.kind === "applying" && (
        <ProcessPanel
          stages={["Restarting opencode"]}
          activeIndex={0}
          status="running"
          elapsedSeconds={applyingElapsed}
          logLines={[]}
        />
      )}

      {phase.kind === "done" && (
        <div className="text-ok">Connected.</div>
      )}

      {phase.kind === "failed" && (
        <div className="space-y-2">
          <Callout tone="danger">{phase.message}</Callout>
          {phase.reason === "claude-cli-install" ? (
            // BET-421 §E.4: three actions — Try again, Use a different
            // model (Codex/Kimi/custom need no binary — this is the
            // important one), Install manually. State plainly that the
            // box itself is fine (already in the message above).
            <div className="flex flex-wrap gap-2">
              <button
                onClick={retry}
                className="px-2 py-1 rounded-xs text-meta"
                style={{ background: "var(--accent-solid)", color: "var(--on-accent)" }}
              >
                Try again
              </button>
              <button
                onClick={onCancel}
                className="px-2 py-1 rounded-xs text-meta"
                style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
              >
                Use a different model
              </button>
              <a
                href="https://claude.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-1 rounded-xs text-meta inline-flex items-center"
                style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
              >
                Install manually
              </a>
            </div>
          ) : (
            <button
              onClick={retry}
              className="px-2 py-1 border border-border rounded-xs text-text-muted hover:text-text"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Device-code block body (BET-421 §D). Renders as ProcessPanel children —
// the spinner + countdown + Cancel live in the ProcessPanel status line.
// Two labelled steps the user works through:
//   1. Open the URL (copy + open).
//   2. Enter the code shown on that page.
// The device code is regex-scraped out of the `instructions` string by
// parseDeviceCode. When nothing parses, deviceCodeFallback points the user
// at the verbatim instructions instead of rendering an empty code slot.
// The upstream `instructions` text is demoted to a collapsed disclosure.
function WaitingBlockBody({
  url,
  instructions,
}: {
  url: string;
  instructions: string;
}) {
  const code = parseDeviceCode(instructions);
  const fallback = deviceCodeFallback(instructions);
  return (
    <div className="space-y-2">
      <div className="text-text">
        <div className="text-label font-medium text-text-faint mb-1">Step 1 — open this link</div>
        {url ? (
          <div className="flex items-center gap-2 min-w-0">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted underline decoration-dotted truncate min-w-0"
              title={url}
            >
              {url.replace(/^https?:\/\//, "")}
            </a>
            <CopyButton text={url} />
          </div>
        ) : (
          <span className="text-text-muted">Open the sign-in page on any device.</span>
        )}
      </div>
      <div className="text-text">
        <div className="text-label font-medium text-text-faint mb-1">Step 2 — enter the code</div>
        {code ? (
          <div className="flex items-center gap-2">
            <code className="font-mono text-text bg-bg px-2 py-px rounded-xs">{code}</code>
            <CopyButton text={code} />
          </div>
        ) : fallback ? (
          <p className="text-text-muted">{fallback}</p>
        ) : (
          <p className="text-text-muted">The code will appear on the page above.</p>
        )}
      </div>
      {instructions && (
        <details className="text-meta">
          <summary className="text-text-faint cursor-pointer hover:text-text-muted">
            Message from ChatGPT
          </summary>
          <pre className="whitespace-pre-wrap text-text-muted mt-1">{instructions}</pre>
        </details>
      )}
    </div>
  );
}

// Single shared input for both OAuth code and API key. They differ only in
// the label, the input `type`, and which action they dispatch — a single
// component avoids the duplicated form / button / error rendering that
// would otherwise drift between the two branches. Submission is handled by
// the parent (which dispatches the right IPC action); the input itself is
// a controlled value + a Submit click.
const CredentialInput = memo(function CredentialInput({
  label,
  type,
  placeholder,
  submitLabel,
  error,
  onSubmit,
}: {
  label: string;
  type: "text" | "password";
  placeholder: string;
  submitLabel: string;
  error?: string;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = value.trim().length > 0 && !submitting;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(value);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="space-y-1">
      <label className="block text-text-faint text-label">{label}</label>
      <div className="flex flex-wrap gap-2">
        <input
          type={type}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 rounded-xs border border-border bg-bg px-2 py-1 font-mono text-text outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="shrink-0 px-2 py-1 rounded-xs border disabled:opacity-40 border-border text-text-muted hover:text-text"
        >
          {submitting ? "…" : submitLabel}
        </button>
      </div>
      {error && <div className="text-danger text-label break-words">{error}</div>}
    </div>
  );
});

// ---------------------------------------------------------------------------
// BET-354: Claude connect card body.
//
// Self-contained — receives everything via props (ptySessionKey, cwd, the
// extracted URL, the pre-existing flag, and any input error). Owns two
// effects: the live URL extraction (re-runs on every pty data event the
// Terminal passes up) and the pty:kill on unmount.
//
// The Terminal component (Terminal.tsx) is the single owner of the
// pty:spawn / pty:write / ptyResize lifecycle; this block only adds the
// connect-flow concerns (URL extraction, code input, server-side cancel
// RPC). Per the issue: "Reuse the existing terminal component, not a <pre>"
// — xterm renders the raw escape sequences the box's `claude auth login`
// emits, so the user actually sees the same TUI as on a terminal.
const CLAUDE_URL_RE =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+/g;

function ClaudeLoginBlock({
  ptySessionKey,
  cwd,
  url,
  preExisting,
  inputError,
  onUrlDetected,
  onSubmitCode,
}: {
  ptySessionKey: string;
  cwd: string;
  url: string;
  preExisting: boolean;
  inputError: string | undefined;
  onUrlDetected: (url: string) => void;
  onSubmitCode: (code: string) => void | Promise<void>;
}) {
  // Track every pty data chunk to extract the OAuth URL as soon as it
  // appears. The Terminal owns the underlying IPty; we re-subscribe to
  // the pty bus here so the URL appears above the terminal pane the
  // moment it's emitted. Filtering is by sessionKey so we never read
  // other terminals' bytes.
  useEffect(() => {
    if (!ptySessionKey || url) return;
    let buffer = "";
    const dispose = window.api.onPtyEvent((ev) => {
      if (ev.sessionKey !== ptySessionKey) return;
      if (ev.kind !== "data") return;
      buffer += ev.data;
      const m = buffer.match(CLAUDE_URL_RE);
      if (m && m[0]) {
        // Strip trailing `)].,;` defensively (terminal soft-wrap can
        // bleed punctuation into the captured chunk).
        onUrlDetected(m[0].replace(/[\]).,;]+$/, ""));
      }
    });
    return () => dispose();
  }, [ptySessionKey, url, onUrlDetected]);

  // Defensive teardown: if the parent unmounts the card (×, retry after
  // failure, navigation away) the IPty is reaped by the Terminal's own
  // cleanup; this effect drops the SERVER-SIDE bookkeeping so a fresh
  // start can register under the same name.
  useEffect(() => {
    if (!ptySessionKey) return;
    return () => {
      void window.api.claudeLoginCancel(ptySessionKey).catch(() => {
        /* best-effort — the IPty is gone via the Terminal's own teardown */
      });
    };
  }, [ptySessionKey]);

  return (
    <div className="space-y-2">
      {preExisting ? (
        <div className="text-text-muted">
          {inputError ?? "Claude is already signed in on this box."}
        </div>
      ) : (
        <>
          <div className="text-text-muted">
            Open the link below in your browser, then paste the code Claude
            shows you here.
          </div>
          {url && (
            <div className="flex items-center gap-2 min-w-0">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-muted underline decoration-dotted truncate min-w-0"
                title={url}
              >
                {url.replace(/^https?:\/\//, "")}
              </a>
              <CopyButton text={url} />
            </div>
          )}
          <CredentialInput
            label="Code from the page"
            type="text"
            placeholder="paste the code"
            submitLabel="Submit"
            error={inputError}
            onSubmit={onSubmitCode}
          />
          {/* BET-421 §D: demote the live terminal to a collapsed disclosure.
              It always being visible at h-40 reads as something going wrong;
              the two labelled steps (URL, then code) above are the card's
              real surface. The raw escape sequences from `claude auth login`
              still render through xterm for users who want to watch. */}
          <details className="text-meta">
            <summary className="text-text-faint cursor-pointer hover:text-text-muted">
              Show what's happening on the box
            </summary>
            <div className="rounded-xs border border-border overflow-hidden h-40 bg-[var(--inset)] mt-1">
              <Terminal
                sessionKey={ptySessionKey}
                cwd={cwd}
                active={true}
                launcher={{ id: "claude-auth-login", flags: {} }}
              />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
