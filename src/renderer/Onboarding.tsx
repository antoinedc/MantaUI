// Onboarding.tsx — full-screen M6.6 onboarding shell (BET-356).
//
// Owns the full-screen container (no sidebar / header / footer), the progress
// rail (numbered dots + connecting lines), fade+slide step transitions, and
// the terminal success screen.
//
// The user-visible flow collapses from four steps (Pair → Providers → Model
// → Project, BET-49) to two (Connect → Connect a provider, BET-356). Model
// is global config (edited in Settings), and the first project is auto-
// created on pair success — no dedicated onboarding step for either.
//
// Onboarding's responsibilities beyond the step machine:
//
//   1. Verify by working (BET-356 §4). After both steps complete (or after
//      step 1 alone, when step 2 auto-skipped because a provider was
//      already connected), `finalizeOnboarding` auto-creates the welcome
//      project + chat window, sends a probe prompt, and waits for a real
//      assistant response. An install that exits zero but cannot answer
//      is a failure the user sees immediately, not later.
//
//   2. Failure and resumption (BET-356 §5). Every failure shows a plain-
//      language cause + one action. The shell re-derives the resume point
//      from config so a quit-mid-flow reopens at the first incomplete
//      step (the underlying `resolveInitialStep` already has this
//      property; the shell just re-uses it on every mount).
//
// Per-step bodies:
//   - Step 1 (Connect)          → PairStep.tsx (SSH picker primary, manual
//                                 disclosure secondary)
//   - Step 2 (Connect provider) → ProvidersStep.tsx (auto-skips on mount
//                                 when a provider is already connected)
//   - Success                   → this file
//
// Those components own their own footers; the shell hides its generic
// footer and lets each step drive advancement (`onPaired` / `onContinue`).

import { useCallback, useEffect, useState } from "react";
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  LAST_STEP,
  prevPosition,
  resolveInitialStep,
  type OnboardingPosition,
} from "./onboardingUtils";
import { useStore } from "./store";
import { PairStep } from "./PairStep";
import { ProvidersStep } from "./ProvidersStep";
import {
  finalizeOnboarding,
  hasConnectedProvider,
  type VerifyApi,
  type VerifyStore,
} from "./onboardingVerify";
import { installHttpTransport } from "./transportInstall";
import { ArrowRight, CheckIcon } from "./onboardingUi";
import mantaMark from "./assets/manta-mark-128.png";

const ACCENT = "#5A88FF"; // matches the app's Tailwind `accent` token

// Progress rail — one dot + connector per step. Reads every numbered step as
// completed on the success screen.
function ProgressRail({ current }: { current: OnboardingPosition }) {
  const activeIdx = current === "success" ? LAST_STEP + 1 : current;
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center justify-center">
        {ONBOARDING_STEPS.map((step, i) => {
          const state: "completed" | "active" | "inactive" =
            step < activeIdx ? "completed" : step === activeIdx ? "active" : "inactive";
          return (
            <div key={step} className="flex items-center">
              {i > 0 && (
                <div
                  className="h-0.5 w-12 sm:w-16 transition-colors"
                  style={{ background: step <= activeIdx ? ACCENT : "#253055" }}
                />
              )}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold transition-all shrink-0"
                style={
                  state === "inactive"
                    ? { background: "#171F3A", color: "#5C6578", border: "1.5px solid #253055" }
                    : state === "active"
                      ? {
                          background: ACCENT,
                          color: "#0B1020",
                          border: `1.5px solid ${ACCENT}`,
                          boxShadow: `0 0 0 4px rgba(124,156,255,0.15)`,
                        }
                      : { background: ACCENT, color: "#0B1020", border: `1.5px solid ${ACCENT}` }
                }
              >
                {state === "completed" ? <CheckIcon className="w-3.5 h-3.5" /> : step}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-center gap-4 mt-3">
        {ONBOARDING_STEPS.map((step) => {
          const isActive = step === activeIdx;
          return (
            <div
              key={step}
              className="text-xs text-center min-w-[60px]"
              style={{ color: isActive ? "#A7B1C4" : "#5C6578", fontWeight: isActive ? 500 : 400 }}
            >
              {STEP_LABELS[step]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Props:
//   onDone — called when onboarding completes (success screen "Open manta") OR
//            is skipped. The parent (App.tsx) re-reads config and drops back
//            to the normal shell WITHOUT an app restart.
export function Onboarding({ onDone }: { onDone: () => void }) {
  // Derive the resume point once from the current config so a quit-mid-flow
  // reopens at the first incomplete step. Read straight from the store's
  // config snapshot (App gates on `loaded`, so config is present by mount).
  //
  // Deep-link pairing (BET-240): if a manta://pair?... URL is pending in the
  // store, force step 1 regardless of the resume point — re-pairing to a new
  // box is a legitimate flow that resolveInitialStep would otherwise skip.
  const [pos, setPos] = useState<OnboardingPosition>(() =>
    useStore.getState().pendingPairLink
      ? 1
      : resolveInitialStep(useStore.getState().configSnapshot()),
  );

  // Verification state — the orchestrator runs after a successful pair +
  // (optional) provider step, before the success screen. The user sees an
  // inline "Verifying your box…" panel while it polls; success replaces it
  // with the "You're all set!" screen.
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Pre-flight for everything that runs AFTER a successful pair: refresh
  // the store from main's config + seed localStorage / swap window.api to
  // httpApi. The SSH claim path persists credentials via main's commit()
  // but does NOT seed localStorage or swap window.api to httpApi (only
  // the manual path's claimBox does). Without this pre-flight, the
  // window.api.opencode* / .tmuxNewSession / .opencodeProviderAuth calls
  // in finalize + hasConnectedProvider fail — the preload has no such
  // surface. The manual path's claimBox already did the install; this
  // re-run is idempotent (localStorage entries + window.api swap).
  const refreshAndInstallTransport = useCallback(async () => {
    await useStore.getState().refresh();
    const cfg = useStore.getState().configSnapshot();
    if (
      typeof cfg.boxToken === "string" &&
      cfg.boxToken.length > 0 &&
      typeof cfg.serverUrl === "string" &&
      cfg.serverUrl.length > 0
    ) {
      installHttpTransport({
        manta_server: cfg.serverUrl.replace(/\/+$/, ""),
        manta_token: cfg.boxToken,
      });
    }
  }, []);

  // The ONE place that manages verifying/verifyError. Every async onboarding
  // phase goes through it — a phase that throws surfaces inline and the user
  // stays put, never a silent stall.
  const runPhase = useCallback(async (fn: () => Promise<void>) => {
    setVerifying(true);
    setVerifyError(null);
    try {
      await fn();
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }, []);

  // The post-pair orchestrator body WITHOUT state management — runPhase owns
  // that. Auto-creates the welcome project + chat window, sends a probe
  // prompt, waits for a real assistant response. On success the shell
  // advances to "success". Kept separate from runPhase so onPaired can run
  // it inline without nesting two runPhase calls (which would clear
  // verifying early).
  //
  // Two entry points route here through runPhase:
  //   - onPaired (step 1): skips to step 2 if no provider is connected,
  //     otherwise runs doFinalize. The "skip if no provider" branch is the
  //     dual of ProvidersStep's mount-time auto-skip, so either side
  //     arriving at finalizeOnboarding means ≥1 provider is connected.
  //   - onProviderContinue (step 2): always runs doFinalize.
  const doFinalize = useCallback(async () => {
    await refreshAndInstallTransport();
    await finalizeOnboarding({
      api: window.api as unknown as VerifyApi,
      store: useStore.getState() as unknown as VerifyStore,
    });
    setPos("success");
  }, [refreshAndInstallTransport]);

  // Step 1 → step 2 (provider needed) OR step 1 → doFinalize (provider
  // already connected). Detecting the latter before stepping forward keeps
  // the user from blinking through an empty step-2 frame.
  //
  // refreshAndInstallTransport FIRST so the hasConnectedProvider probe
  // (and the upcoming finalize) actually reach the box. The whole body runs
  // inside runPhase so a rejection surfaces inline instead of stalling.
  const onPaired = useCallback(
    () =>
      runPhase(async () => {
        await refreshAndInstallTransport();
        const connected = await hasConnectedProvider(
          window.api as unknown as VerifyApi,
        );
        if (connected) {
          await doFinalize();
        } else {
          setPos(2);
        }
      }),
    [runPhase, refreshAndInstallTransport, doFinalize],
  );

  // Step 2 → finalize (provider connect just landed → run the verify).
  const onProviderContinue = useCallback(() => runPhase(doFinalize), [
    runPhase,
    doFinalize,
  ]);

  const goBack = () => setPos((p) => prevPosition(p));

  // Skip: persist onboardingSkipped so the flow doesn't re-trigger on every
  // launch of an otherwise-empty config, then hand control back to the shell.
  // Reserved for future Settings-driven "Skip setup" re-runs (BET-382 §A.3);
  // today the renderer's `Skip setup` button is gone, so the only caller is
  // a future Settings affordance that hasn't landed yet. `void skip;` keeps
  // the function referenced for TS while we wait.
  const skip = async () => {
    await useStore.getState().skipOnboarding();
    onDone();
  };
  void skip;

  // Deep-link pairing (BET-240): a link that arrives WHILE onboarding is
  // already open (e.g. user clicked the link from Terminal after the app
  // was running) must also jump to step 1.
  const pendingPairLink = useStore((s) => s.pendingPairLink);
  useEffect(() => {
    if (pendingPairLink) setPos(1);
  }, [pendingPairLink]);

  const isSuccess = pos === "success";

  return (
    <div className="fixed inset-0 z-50 bg-bg text-text flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-[720px] px-6 py-8">
        {/* Header: logo + progress rail (hidden on the success screen). */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2.5 mb-8">
            <img src={mantaMark} alt="" className="w-9 h-9 object-contain" />
            <span className="text-xl font-semibold tracking-tight">Manta</span>
          </div>
          {!isSuccess && <ProgressRail current={pos} />}
        </div>

        {/* Step body. `key` on the wrapper restarts the fade+slide animation on
            every position change. */}
        <div className="relative overflow-hidden">
          <div key={String(pos)} className="onboarding-step-enter">
            {isSuccess ? (
              <SuccessPanel onOpen={onDone} />
            ) : pos === 1 ? (
              <PairStep onPaired={onPaired} />
            ) : pos === 2 ? (
              <ProvidersStep
                onBack={goBack}
                onContinue={onProviderContinue}
              />
            ) : null}
          </div>
        </div>

        {/* Verification overlay — sits below the step body so it doesn't
            obscure the active step's controls. Only visible mid-finalize. */}
        {verifying && (
          <div
            role="status"
            aria-live="polite"
            className="mt-6 rounded-md border border-border bg-bg-soft px-4 py-3 text-sm text-text-muted flex items-center gap-3"
          >
            <span
              aria-hidden
              className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
            />
            Verifying your box…
          </div>
        )}
        {verifyError && (
          <div
            role="alert"
            className="mt-6 rounded-md border px-4 py-3 text-sm"
            style={{ borderColor: "#FF7A88", color: "#FF7A88" }}
          >
            {verifyError}
          </div>
        )}
      </div>
    </div>
  );
}

// The terminal success screen — moved out of Onboarding's render body so the
// step-body slot above stays readable. "Open Manta" hands control back to
// the parent; App.tsx drops back to the normal shell on onDone.
function SuccessPanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="text-center py-5">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5"
        style={{ background: "rgba(34,197,94,0.1)" }}
      >
        <CheckIcon className="w-7 h-7 text-green-400" />
      </div>
      <h2 className="text-2xl font-semibold mb-2">You're all set!</h2>
      <p className="text-sm text-text-muted leading-relaxed max-w-sm mx-auto mb-7">
        Your box is paired, a provider is connected, and your first project is
        ready. Start chatting with your AI assistant.
      </p>
      <button
        onClick={onOpen}
        className="inline-flex items-center gap-2 px-6 py-2.5 rounded-md text-sm font-medium text-bg"
        style={{ background: ACCENT }}
      >
        Open Manta
        <ArrowRight />
      </button>
    </div>
  );
}
