// SshInstallStep.tsx — SSH installer harness for the desktop onboarding
// "Connect your box" step (BET-355 / BET-382 / BET-383 / BET-384).
//
// PairStep renders this component inline as the primary surface when an
// SSH installer preload is available and no deep-link is pending. The
// step-level heading + intro live in PairStep — this component renders no
// header of its own (BET-382), it just drops straight into the host
// picker. On success it calls onPaired(), the same callback the manual
// form uses, so the onboarding shell advances identically regardless of
// which path closed the deal.
//
// BET-383: exactly one entry point — Install & pair. Preflight runs as
// phase 1 in the main process; no standalone button, no verdict that can go
// stale, and a failed check aborts before anything is written to the box.
// The six-row checklist is gone in favour of one status line over an
// always-mounted, auto-scrolling log that collapses on success.
//
// BET-384: the host list can be re-read without an app restart (the
// `loadHosts()` callback backs both the mount effect and the refresh
// button), and "Custom host…" is a permanent last entry in the SAME
// `<select>` — there is exactly one host control, never a select-or-input
// branch. Selecting it reveals a small panel (host/port/user/identity
// file); `resolveInstallTarget` (src/shared/sshTarget.ts) turns whichever
// branch is active into the single value installerStart /
// installerMintAndClaim consume — this component assembles no target
// string of its own.
//
// All decision logic lives in the main-process installer module (plus the
// pure src/shared/sshTarget.ts target resolver). This component is React
// state + per-event dispatch + JSX, nothing more.

import { useCallback, useEffect, useState, useRef } from "react";
import {
  getMantaPreload,
  type InstallerEvent,
  type PreflightFailure,
} from "./preloadAccess";
import { currentStageInfo, INSTALL_STAGES, type InstallStageId } from "../shared/installStages";
import { ProcessPanel } from "./ProcessPanel";
import {
  CUSTOM_HOST_VALUE,
  resolveInstallTarget,
  sshTargetLabel,
  type HostFieldSelection,
} from "../shared/sshTarget";
import type { ClaimOutcome } from "../shared/claim.mjs";

const ACCENT = "var(--accent)";
const ACCENT_SOLID = "var(--accent-solid)"; // filled buttons (BET-409 AA)
const DANGER = "var(--danger)";

// Keep the last N log lines only — main already caps its own tail at 200
// (handlers.ts LOG_TAIL_MAX); the renderer needs its own cap too, or a long
// install grows the DOM without bound.
const LOG_LINES_MAX = 500;

// How long the count line's "· just now" suffix stays visible after a
// manual refresh before decaying back to the plain count (BET-384 review
// cycle 1 nit).
const JUST_REFRESHED_DECAY_MS = 60_000;

// BET-390 amendment: the install's final act starts/restarts the box service,
// and the auto-claim fires the instant the install process exits — so the
// first mint can race a service that isn't listening on loopback yet. A
// single retry after this wait fixes the observed non-deterministic failure;
// the retry is bounded to one extra attempt and the final failure still
// surfaces the real message. Only transient kinds (network / server_error)
// are retried — a wrong_code or invalid_response won't be fixed by trying
// again.
const CLAIM_RETRY_DELAY_MS = 3_000;

const INITIAL_STAGE: InstallStageId = "preflight";
const INITIAL_STAGE_INFO = currentStageInfo(INITIAL_STAGE);

// The installer's ProcessPanel stages — the ordered INSTALL_STAGES labels.
// `currentStageInfo` is 1-based, so the panel's 0-based activeIndex is
// `stageIndex - 1`. Using all six entries preserves the original "N of 6"
// counter (the SSH installer always showed six steps).
const INSTALL_STAGE_LABELS: string[] = INSTALL_STAGES.map((s) => s.label);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// BET-390: only failure kinds that can be caused by the box service not being
// ready yet are worth a retry. A wrong/expired code or a malformed response
// won't change on a second attempt.
function isTransientClaimFailure(outcome: ClaimOutcome): boolean {
  return !outcome.ok && (outcome.kind === "network" || outcome.kind === "server_error");
}

export function SshInstallStep({ onPaired }: { onPaired: () => void }) {
  // The preload bridge — null on mobile/web (the issue's "SSH is installer-
  // only" rule means this UI never renders without a preload). Render an
  // explicit fallback instead of silently failing — mirrors how PairStep
  // handles a missing window.api.
  const preloadOrNull = getMantaPreload();
  if (!preloadOrNull) {
    return (
      <div className="text-center py-6 text-body text-text-muted">
        The SSH installer is only available in the desktop app.
      </div>
    );
  }
  // Non-null alias — TypeScript can't narrow the return of getMantaPreload()
  // because it's not declared as a type predicate, so we capture it once
  // and use the non-null name throughout the body.
  const preload = preloadOrNull;

  // ---------- State ----------
  const [hosts, setHosts] = useState<Array<{ alias: string; patterns: string[] }>>(
    [],
  );
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostsLoading, setHostsLoading] = useState(false);
  // True right after a manual refresh completes — flips the count line's
  // suffix to "· just now" (BET-384). Decays back to false on its own
  // (JUST_REFRESHED_DECAY_MS below) — review cycle 1 nit: a "just now"
  // that never expires is worse than no timestamp at all.
  const [justRefreshed, setJustRefreshed] = useState(false);
  // The <select> value: a real alias, or CUSTOM_HOST_VALUE. Starts on the
  // sentinel so the select always has a valid selected option (one of the
  // custom option, which is always rendered) even before the first
  // installerListHosts() response lands — no empty-string flash.
  const [alias, setAlias] = useState(CUSTOM_HOST_VALUE);
  // Custom-host panel fields (BET-384) — only read when alias ===
  // CUSTOM_HOST_VALUE. Never persisted, never written to ~/.ssh/config.
  const [customHost, setCustomHost] = useState("");
  const [customPort, setCustomPort] = useState("");
  const [customUser, setCustomUser] = useState("");
  const [customIdentityFile, setCustomIdentityFile] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallStageId>(INITIAL_STAGE);
  const [stageIndex, setStageIndex] = useState(INITIAL_STAGE_INFO.index);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<
    | { ok: boolean; code: number | null; signal: NodeJS.Signals | null }
    | null
  >(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // From a `preflight-failed` event — checks failed before any write.
  // Rendered as its own card, never folded into the progress panel.
  const [preflightFailure, setPreflightFailure] = useState<{
    failures: PreflightFailure[];
  } | null>(null);
  // BET-361: a never-seen host paused the install for a trust decision.
  // Rendered INLINE in the progress panel (the status line flips to
  // "Waiting for host trust…" and the log pauses) — not a separate panel.
  const [fingerprintPrompt, setFingerprintPrompt] = useState<{
    handleId: string;
    algo: string;
    sha256: string;
  } | null>(null);
  // BET-360: a passphrase-protected key (not in ssh-agent) paused the
  // install for a passphrase. Rendered INLINE in the progress panel (same
  // pattern as the fingerprint card) — a password input + Submit/Cancel.
  const [passphrasePrompt, setPassphrasePrompt] = useState<{
    handleId: string;
    prompt: string;
  } | null>(null);
  const [passphraseInput, setPassphraseInput] = useState("");
  const [claimRunning, setClaimRunning] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  // ---------- Host list load (mount + manual refresh share this) ----------
  //
  // BET-384: editing ~/.ssh/config used to require restarting the whole app
  // because the list was read once in a mount effect with no way back in.
  // `loadHosts()` is the single fetch both the mount effect and the
  // refresh button call — re-reads the config and nothing else (no
  // preflight, no re-check; there is nothing left to re-run since BET-383
  // folded preflight into the install click).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // True once the FIRST load (success or failure) has completed. `alias`
  // starts on CUSTOM_HOST_VALUE as a rendering bootstrap (see its own
  // comment below) — that initial value is not a real user choice, so it
  // must not be treated as "the user deliberately picked Custom host" the
  // one time loadHosts's setAlias updater sees it. Caught while fixing the
  // review cycle 1 Block: without this, a populated ~/.ssh/config would
  // never auto-select the first alias — `prev === CUSTOM_HOST_VALUE` would
  // always be true on that first pass and short-circuit before the
  // list[0]-alias fallback ever ran.
  const hasLoadedOnceRef = useRef(false);

  const loadHosts = useCallback(
    async (opts?: { manual?: boolean }) => {
      setHostsLoading(true);
      const isFirstLoad = !hasLoadedOnceRef.current;
      try {
        const list = await preload.installerListHosts();
        if (!aliveRef.current) return;
        setHosts(list);
        setAlias((prev) => {
          if (isFirstLoad) {
            // Bootstrap pass: `prev` is just the initial sentinel, not a
            // real selection — pick the first alias when the config has
            // entries, or fall back to the sentinel (decision #3) when it
            // doesn't.
            return list.length > 0 ? list[0].alias : CUSTOM_HOST_VALUE;
          }
          // A later refresh: keep the current selection if it's still
          // valid (still present in the refreshed list, or the custom
          // sentinel — refresh never closes an open custom panel the user
          // deliberately opened). Otherwise fall back the same way.
          if (prev === CUSTOM_HOST_VALUE) return prev;
          if (list.some((h) => h.alias === prev)) return prev;
          return list.length > 0 ? list[0].alias : CUSTOM_HOST_VALUE;
        });
        if (opts?.manual) setJustRefreshed(true);
      } catch {
        if (!aliveRef.current) return;
        // First-load failure: hosts/alias are already at their
        // [] / CUSTOM_HOST_VALUE initial state, so there's nothing to
        // reset — the empty-config UI (decision #3) falls out for free.
        // A LATER refresh's failure must NOT discard whatever host list
        // and selection were already on screen — a transient read error
        // is not license to yank the panel open out from under the user
        // (review cycle 1 nit).
        if (isFirstLoad) {
          setHosts([]);
          setAlias(CUSTOM_HOST_VALUE);
        }
      } finally {
        if (aliveRef.current) {
          setHostsLoaded(true);
          setHostsLoading(false);
        }
        hasLoadedOnceRef.current = true;
      }
    },
    [preload],
  );

  useEffect(() => {
    void loadHosts();
    // Mount-only — loadHosts is stable across the preload's lifetime (the
    // preload accessor never changes after mount) and the refresh button
    // calls it directly, so re-running this effect on every loadHosts
    // identity change would just be the same fetch twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recover any in-flight install on mount (a page refresh mid-install
  // shouldn't strand the user), or a preflight failure the user hasn't
  // dismissed yet — main echoes the real verdict, no placeholder needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await preload.installerState();
      if (!alive) return;
      // BET-361: a paused trust prompt recovers first — it's neither an
      // active install nor a hard preflight failure, and the unknown-host
      // verdict sitting in `s.preflight` must NOT be rendered as the
      // failure card while we're waiting on the user.
      if (s.waitingForTrust && s.trustHandleId && s.pendingFingerprint) {
        setRunning(true);
        setActiveHandle(s.trustHandleId);
        setStage(INITIAL_STAGE);
        setStageIndex(INITIAL_STAGE_INFO.index);
        setFingerprintPrompt({
          handleId: s.trustHandleId,
          algo: s.pendingFingerprint.algo,
          sha256: s.pendingFingerprint.sha256,
        });
        return;
      }
      // BET-360: recover a paused passphrase prompt on remount.
      if (s.waitingForPassphrase && s.passphraseHandleId) {
        setRunning(true);
        setActiveHandle(s.passphraseHandleId);
        setStage(INITIAL_STAGE);
        setStageIndex(INITIAL_STAGE_INFO.index);
        setPassphrasePrompt({
          handleId: s.passphraseHandleId,
          prompt: "Enter the passphrase for your SSH key:",
        });
        setPassphraseInput("");
        return;
      }
      if (s.active) {
        const info = currentStageInfo(s.stage);
        setRunning(true);
        setStage(s.stage);
        setStageIndex(info.index);
        setLines(s.logTail);
      } else if (s.preflight && !s.preflight.ok) {
        setPreflightFailure({ failures: s.preflight.failures });
      }
    })();
    return () => {
      alive = false;
    };
  }, [preload]);

  // Subscribe to installer events. Re-subscribes when the active handle
  // changes so stale events from a previous handle don't bleed into the UI.
  useEffect(() => {
    const unsub = preload.onInstallerEvent((evt: InstallerEvent) => {
      // Only react to events from the CURRENT handle — stale events from a
      // previous install (after the user clicked Cancel + tried again) must
      // not update the new install's UI.
      if (activeHandle !== null && evt.handleId !== activeHandle) return;
      switch (evt.kind) {
        case "line":
          setLines((prev) => {
            const next = [...prev, evt.text];
            return next.length > LOG_LINES_MAX
              ? next.slice(next.length - LOG_LINES_MAX)
              : next;
          });
          break;
        case "stage": {
          const info = currentStageInfo(evt.stage);
          setStage(evt.stage);
          setStageIndex(info.index);
          break;
        }
        case "preflight-failed":
          // Nothing was written to the box — the progress panel never
          // shows for this case.
          setPreflightFailure({ failures: evt.failures });
          setRunning(false);
          setActiveHandle(null);
          setFingerprintPrompt(null);
          setPassphrasePrompt(null);
          setPassphraseInput("");
          break;
        case "fingerprint":
          // The install is paused waiting for a trust decision — show the
          // fingerprint card inline. The handleId on the event is what
          // installerTrustHost needs (installerStart hasn't returned yet,
          // so activeHandle is still null here).
          setFingerprintPrompt({
            handleId: evt.handleId,
            algo: evt.fingerprint.algo,
            sha256: evt.fingerprint.sha256,
          });
          break;
        case "passphrase":
          // BET-360: the install is paused waiting for the SSH key
          // passphrase — show the passphrase input card inline.
          setPassphrasePrompt({ handleId: evt.handleId, prompt: evt.prompt });
          setPassphraseInput("");
          break;
        case "done":
          setDone({ ok: evt.ok, code: evt.code, signal: evt.signal });
          setRunning(false);
          setActiveHandle(null);
          setFingerprintPrompt(null);
          setPassphrasePrompt(null);
          setPassphraseInput("");
          if (evt.ok) {
            // Auto-claim on success — the whole point of the flow. The
            // user typed a host, nothing else.
            void runClaim();
          }
          break;
        case "error":
          setInstallError(evt.message);
          setRunning(false);
          setActiveHandle(null);
          setFingerprintPrompt(null);
          setPassphrasePrompt(null);
          setPassphraseInput("");
          break;
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload, activeHandle]);

  // Tick the elapsed-time display once a second while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Decay "· just now" back to the plain count line after a while — a
  // timestamp that never expires reads as wrong once enough time has
  // actually passed (BET-384 review cycle 1 nit).
  useEffect(() => {
    if (!justRefreshed) return;
    const t = setTimeout(() => setJustRefreshed(false), JUST_REFRESHED_DECAY_MS);
    return () => clearTimeout(t);
  }, [justRefreshed]);

  // ---------- Actions ----------

  // Current host-picker selection in the shape resolveInstallTarget takes —
  // one function, called wherever the resolved target is needed (BET-384:
  // "the component contains no target-string assembly", only this
  // pass-through into the pure resolver).
  function currentSelection(): HostFieldSelection {
    return {
      alias,
      host: customHost,
      port: customPort,
      user: customUser,
      identityFile: customIdentityFile,
    };
  }

  async function startInstall() {
    const resolved = resolveInstallTarget(currentSelection());
    if (!resolved.ok) {
      setTargetError(resolved.error);
      return;
    }
    setTargetError(null);
    setInstallError(null);
    setPreflightFailure(null);
    setFingerprintPrompt(null);
    setPassphrasePrompt(null);
    setPassphraseInput("");
    setLines([]);
    setDone(null);
    setClaimError(null);
    // Clear the previous handle so the event guard doesn't discard this
    // install's events (esp. a `preflight-failed` push, which main sends
    // BEFORE the installerStart invoke below resolves) while it's still
    // filtering against a prior, now-dead handle.
    setActiveHandle(null);
    setStage(INITIAL_STAGE);
    setStageIndex(INITIAL_STAGE_INFO.index);
    setElapsedSeconds(0);
    // Mount the progress panel immediately on click — no gap before the
    // main process's response comes back.
    setRunning(true);
    try {
      const { handleId } = await preload.installerStart({ alias: resolved.target });
      setActiveHandle(handleId);
    } catch (e) {
      setRunning(false);
      setInstallError(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancelInstall() {
    // During the fingerprint trust pause OR the passphrase pause,
    // activeHandle is still null (installerStart hasn't returned) — but the
    // install IS in flight and the Cancel button is visible. Route through
    // the paused prompt's handleId so installerCancel reaches the main-
    // process abort instead of silently no-oping (BET-361/360).
    const handleId = activeHandle ?? fingerprintPrompt?.handleId ?? passphrasePrompt?.handleId;
    if (!handleId) return;
    await preload.installerCancel({ handleId });
  }

  // BET-361: answer the paused fingerprint prompt. Trust → main writes the
  // host key and resumes (running stays true, the install streams on).
  // Decline → main aborts with a preflight-failed event; we drop the
  // spinner immediately so the UI never hangs on a verdict that's already
  // been decided.
  async function trustHostDecision(trust: boolean) {
    if (!fingerprintPrompt) return;
    const handleId = fingerprintPrompt.handleId;
    setFingerprintPrompt(null);
    if (!trust) {
      setRunning(false);
      setActiveHandle(null);
    }
    try {
      await preload.installerTrustHost({ handleId, trust });
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    }
  }

  // BET-360: submit the entered passphrase (or cancel). Submit → main
  // creates an SSH_ASKPASS session and re-runs preflight; the install
  // resumes streaming. Cancel → main aborts with a preflight-failed event;
  // we drop the spinner immediately.
  async function submitPassphrase(submit: boolean) {
    if (!passphrasePrompt) return;
    const handleId = passphrasePrompt.handleId;
    const pw = submit ? passphraseInput : null;
    setPassphrasePrompt(null);
    setPassphraseInput("");
    if (!submit) {
      setRunning(false);
      setActiveHandle(null);
    }
    try {
      await preload.installerAskpassRespond({ handleId, passphrase: pw });
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runClaim() {
    const resolved = resolveInstallTarget(currentSelection());
    if (!resolved.ok) {
      setClaimError(resolved.error);
      return;
    }
    setClaimRunning(true);
    setClaimError(null);
    try {
      const outcome = await preload.installerMintAndClaim({
        alias: resolved.target,
      });
      if (outcome.ok) {
        // Mirror the manual PairStep onPaired — advances onboarding to
        // step 2 exactly as a typed pairing code would.
        onPaired();
        return;
      }
      // BET-390 amendment: a transient failure (the box service not yet
      // listening) is retried once after a short wait. claimRunning stays
      // true across the wait so the banner keeps reading "Pairing…".
      if (isTransientClaimFailure(outcome)) {
        await sleep(CLAIM_RETRY_DELAY_MS);
        const retry = await preload.installerMintAndClaim({
          alias: resolved.target,
        });
        if (retry.ok) {
          onPaired();
          return;
        }
        setClaimError(`Pairing failed: ${retry.message}`);
      } else {
        setClaimError(`Pairing failed: ${outcome.message}`);
      }
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaimRunning(false);
    }
  }

  async function copyDiagnostics() {
    // Read the real preflight verdict back from main — always populated by
    // the time this button can be visible. No placeholder.
    const s = await preload.installerState();
    if (!s.preflight) return;
    const resolved = resolveInstallTarget(currentSelection());
    const r = await preload.installerGetDiagnostics({
      preflight: s.preflight,
      stage,
      logTail: lines,
      alias: resolved.ok ? sshTargetLabel(resolved.target) : alias,
    });
    await navigator.clipboard.writeText(r);
  }

  // ---------- Render ----------
  const installDisabled =
    running || claimRunning || !resolveInstallTarget(currentSelection()).ok;
  const hostCountLabel = hostsLoading
    ? "reading ~/.ssh/config…"
    : !hostsLoaded
      ? ""
      : hosts.length === 0
        ? "No hosts in ~/.ssh/config"
        : `${hosts.length} hosts from ~/.ssh/config${justRefreshed ? " · just now" : ""}`;
  // Keep the panel (status line + log) mounted through an install error too
  // — that's the log line the user needs most ("is it stuck, or just
  // slow?"). Only the preflight-failure card excludes it (nothing was
  // written to the box, so there's no install log to show).
  const showProgress =
    !preflightFailure &&
    (running || done !== null || (installError !== null && lines.length > 0));

  return (
    <div className="space-y-5">
      {/* Host picker — PairStep owns the step-level heading + intro
          (BET-382); this component drops straight into the picker.
          BET-384: exactly one host control, always a <select> — "Custom
          host…" is a permanent last option, present whether or not the
          config has entries, never a second input rendered alongside it. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-body font-medium" htmlFor="ssh-host">
            Host
          </label>
          <span className="text-meta text-text-faint">{hostCountLabel}</span>
        </div>
        <div className="flex gap-2">
          <select
            id="ssh-host"
            value={alias}
            onChange={(e) => {
              setAlias(e.target.value);
              setTargetError(null);
            }}
            disabled={running || claimRunning}
            className="flex-1 min-w-0 rounded-md bg-bg-elev px-3 py-2 text-body border border-border focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {hosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {h.alias}
                {h.patterns.length > 1 ? ` (${h.patterns.join(", ")})` : ""}
              </option>
            ))}
            <option value={CUSTOM_HOST_VALUE}>Custom host…</option>
          </select>
          <button
            type="button"
            onClick={() => void loadHosts({ manual: true })}
            disabled={hostsLoading || running || claimRunning}
            aria-label="Refresh host list"
            title="Re-read ~/.ssh/config"
            className="w-[34px] h-[34px] shrink-0 flex items-center justify-center rounded-md bg-bg-elev border border-border text-text-muted hover:text-text hover:border-border-strong transition-colors disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`w-3.5 h-3.5${hostsLoading ? " animate-spin" : ""}`}
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-2.6-6.4" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>

        {/* Custom host panel — only rendered for the custom sentinel, AND
            only once the host load has settled (review cycle 1 Block):
            `alias` starts on the sentinel so the <select> always has a
            valid selected option before installerListHosts() resolves,
            but painting the panel during that window means a populated
            ~/.ssh/config flashes the full four-field panel open and then
            collapses once the real alias list lands. Gating on
            `hostsLoaded` too keeps decision #3 intact — hostsLoaded is
            true in both loadHosts' success and catch paths, so the
            empty-config case still opens the panel pre-selected, exactly
            as required — while a populated config never shows it before
            the list is ready. No second host control ever coexists with
            the select either way. */}
        {hostsLoaded && alias === CUSTOM_HOST_VALUE && (
          <div className="rounded-md border border-border bg-bg-soft p-4 space-y-3">
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <div className="flex flex-col gap-1">
                <label
                  className="text-label font-medium text-text-muted"
                  htmlFor="ssh-custom-host"
                >
                  Host or IP
                </label>
                <input
                  id="ssh-custom-host"
                  type="text"
                  placeholder="box.example.com"
                  value={customHost}
                  onChange={(e) => {
                    setCustomHost(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-body border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-label font-medium text-text-muted"
                  htmlFor="ssh-custom-port"
                >
                  Port
                </label>
                <input
                  id="ssh-custom-port"
                  type="text"
                  inputMode="numeric"
                  placeholder="22"
                  value={customPort}
                  onChange={(e) => {
                    setCustomPort(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-body border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label
                  className="text-label font-medium text-text-muted"
                  htmlFor="ssh-custom-user"
                >
                  User
                </label>
                <input
                  id="ssh-custom-user"
                  type="text"
                  placeholder="root"
                  value={customUser}
                  onChange={(e) => {
                    setCustomUser(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-body border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-label font-medium text-text-muted"
                  htmlFor="ssh-custom-identity"
                >
                  Identity file
                </label>
                {/* BET-387: Browse button opens the native file picker via
                    the preload's dialogShowOpenFile bridge (defaults to
                    ~/.ssh/). A plain text input remains the fallback —
                    typing a path directly still works, and the field is
                    fully usable on mobile/web where the bridge is absent
                    (the button is hidden there). */}
                <div className="flex gap-2">
                  <input
                    id="ssh-custom-identity"
                    type="text"
                    placeholder="~/.ssh/id_ed25519"
                    value={customIdentityFile}
                    onChange={(e) => {
                      setCustomIdentityFile(e.target.value);
                      setTargetError(null);
                    }}
                    disabled={running || claimRunning}
                    className="flex-1 min-w-0 rounded-md bg-bg-elev px-3 py-2 text-body border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await preload.dialogShowOpenFile();
                      if (!result.canceled) {
                        setCustomIdentityFile(result.path);
                        setTargetError(null);
                      }
                    }}
                    disabled={running || claimRunning}
                    className="shrink-0 px-3 py-2 rounded-md text-body font-medium bg-bg-elev border border-border text-text-muted hover:text-text hover:border-border-strong transition-colors disabled:opacity-50"
                  >
                    Browse
                  </button>
                </div>
              </div>
            </div>
            <p className="text-meta text-text-faint">
              Leave a field empty to let OpenSSH decide. These are used for
              this box only — your ~/.ssh/config is never written to.
            </p>
          </div>
        )}

        {/* Hoisted out of the custom panel (review cycle 1 nit): the panel
            only renders for the custom branch, but resolveInstallTarget
            can also reject the alias branch (defensive — unreachable
            through this UI today since the <select>'s only values are a
            parsed alias or the sentinel, but resolveInstallTarget is a
            shared pure function and must not silently swallow a future
            caller's bad input). Rendering the error here, outside the
            panel, means it's never lost regardless of which branch
            produced it. */}
        {targetError && (
          <p className="text-meta" style={{ color: DANGER }}>
            {targetError}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={startInstall}
            disabled={installDisabled}
            className="px-4 py-2 rounded-md text-body font-medium disabled:opacity-50"
            style={{ background: ACCENT_SOLID, color: "var(--on-accent)" }}
          >
            {running ? "Installing…" : "Install & pair"}
          </button>
          {running && (
            <button
              onClick={cancelInstall}
              className="px-4 py-2 rounded-md text-body font-medium"
              style={{ border: `1px solid ${DANGER}`, color: DANGER }}
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      {/* Preflight failure — checks ran before any write; must not read as
          a failed install. Never shown alongside the progress panel. */}
      {preflightFailure && (
        <section className="space-y-2 text-body">
          <ul className="space-y-1">
            {preflightFailure.failures.map((f, i) => (
              <li
                key={i}
                className="rounded-md px-3 py-2"
                style={{ border: `1px solid ${DANGER}`, color: DANGER }}
              >
                <div className="font-medium">{f.cause}</div>
                <div className="text-meta mt-px opacity-80">{f.action}</div>
              </li>
            ))}
          </ul>
          <p className="text-meta text-text-muted">
            Nothing was installed or changed on the box — the checks run
            before any write.
          </p>
        </section>
      )}

      {/* Status line + progress bar + live log — mounted on click, streams,
          auto-scrolls, collapses to the single line on success. The shared
          ProcessPanel (BET-421 §A) renders the chrome; the fingerprint and
          passphrase prompts pass as children so they render between the bar
          and the log, exactly where they lived before the extraction. */}
      {showProgress && (
        <ProcessPanel
          stages={INSTALL_STAGE_LABELS}
          activeIndex={Math.max(0, stageIndex - 1)}
          status={
            done ? (done.ok ? "done" : "error") : installError ? "error" : "running"
          }
          elapsedSeconds={elapsedSeconds}
          logLines={lines}
          onCopyDiagnostics={copyDiagnostics}
        >
          {/* BET-361: inline fingerprint prompt. The install is paused — the
              log has nothing new to show, so the card takes the place of
              attention until the user answers. */}
          {fingerprintPrompt && (
            <div
              className="rounded-md p-4 space-y-3"
              style={{ border: `1px solid ${ACCENT}` }}
            >
              <div className="text-body font-medium">Trust this host?</div>
              <p className="text-meta text-text-muted">
                The host's identity can't be verified yet. Its{" "}
                {fingerprintPrompt.algo} key fingerprint is:
              </p>
              <code
                className="block text-meta font-mono break-all rounded px-2 py-2 bg-bg-elev"
                style={{ color: ACCENT }}
              >
                {fingerprintPrompt.sha256}
              </code>
              <p className="text-meta text-text-faint">
                Only trust this if you recognize the fingerprint (for example,
                from your VPS console). The key is saved to
                ~/.ssh/known_hosts so future connections skip this prompt.
              </p>
              <div className="flex gap-2 pt-px">
                <button
                  onClick={() => void trustHostDecision(true)}
                  className="px-3 py-2 rounded-md text-body font-medium"
                  style={{ background: ACCENT_SOLID, color: "var(--on-accent)" }}
                >
                  Trust &amp; continue
                </button>
                <button
                  onClick={() => void trustHostDecision(false)}
                  className="px-3 py-2 rounded-md text-body font-medium"
                  style={{ border: `1px solid ${DANGER}`, color: DANGER }}
                >
                  Don't trust
                </button>
              </div>
            </div>
          )}
          {/* BET-360: inline passphrase prompt. The install is paused —
              the key is passphrase-protected and not in ssh-agent. The
              user enters the passphrase once; main caches it in a temp
              file for every ssh invocation in the rest of the flow. */}
          {passphrasePrompt && (
            <div
              className="rounded-md p-4 space-y-3"
              style={{ border: `1px solid ${ACCENT}` }}
            >
              <div className="text-body font-medium">{passphrasePrompt.prompt}</div>
              <p className="text-meta text-text-muted">
                Your SSH key is passphrase-protected and not loaded in
                ssh-agent. Enter the passphrase to decrypt it for this
                install — it is used only in-memory and never stored.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitPassphrase(passphraseInput.length > 0);
                }}
                className="space-y-2"
              >
                <input
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  autoFocus
                  placeholder="Passphrase"
                  className="w-full rounded-md px-3 py-2 text-body bg-bg-elev"
                  style={{ border: `1px solid ${ACCENT}` }}
                />
                <div className="flex gap-2 pt-px">
                  <button
                    type="submit"
                    disabled={passphraseInput.length === 0}
                    className="px-3 py-2 rounded-md text-body font-medium disabled:opacity-40"
                    style={{ background: ACCENT_SOLID, color: "var(--on-accent)" }}
                  >
                    Unlock &amp; continue
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitPassphrase(false)}
                    className="px-3 py-2 rounded-md text-body font-medium"
                    style={{ border: `1px solid ${DANGER}`, color: DANGER }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </ProcessPanel>
      )}

      {/* In-flight claim only. There is no success message: a successful
          claim advances onboarding to step 2, which unmounts this step. */}
      {claimRunning && <section className="text-body">Pairing…</section>}
      {done && !done.ok && (
        <section
          className="text-body space-y-2"
          style={{ color: DANGER }}
        >
          {/* No Copy diagnostics button here: ProcessPanel renders exactly one
              on error, directly under the failed stage. This section used to
              render a second copy of it. */}
          <div>
            Install failed (exit code {done.code ?? "—"}
            {done.signal ? `, signal ${done.signal}` : ""}).
          </div>
        </section>
      )}
      {installError && (
        <section className="text-body" style={{ color: DANGER }}>
          {installError}
        </section>
      )}
      {claimError && (
        <section className="text-body space-y-1" style={{ color: DANGER }}>
          <div>{claimError}</div>
          <div>
            Pair manually: run <code>manta pair</code> on the box for a fresh
            6-digit code, then open the "Pair to an existing box" form on this
            page and enter it.
          </div>
        </section>
      )}
    </div>
  );
}
