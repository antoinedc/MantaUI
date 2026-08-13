// Onboarding.tsx — full-screen M6.6 onboarding shell (BET-356, BET-421).
//
// Owns the full-screen container (no sidebar / header / footer), the progress
// rail (numbered dots + connecting lines), fade+slide step transitions, and
// the terminal success screen.
//
// The user-visible flow is two steps (Connect → Connect a provider). Model is
// global config (edited in Settings); no dedicated onboarding step for it.
//
// Onboarding's responsibilities beyond the step machine:
//
//   1. Verify by working (BET-421 §B). After both steps complete (or after
//      step 1 alone, when step 2 auto-skipped because a provider was already
//      connected), `verifyOnboarding` spins up an EPHEMERAL opencode session
//      (no project, no sidebar entry), sends one probe prompt, waits for a
//      real assistant reply, and deletes the session. Three named stages
//      drive a ProcessPanel; on failure the user sees which stage failed +
//      Try again / Back to the provider step / Copy diagnostics. No "continue
//      anyway" — a working model is mandatory.
//
//   2. Failure and resumption. Every failure shows a plain-language cause +
//      one way forward. The shell re-derives the resume point from config so
//      a quit-mid-flow reopens at the first incomplete step.
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

import { useCallback, useEffect, useRef, useState } from "react";
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
  verifyOnboarding,
  hasConnectedProvider,
  pickVerifyLabels,
  verifyStageLabels,
  type VerifyProgress,
  type VerifyStageIndex,
} from "./onboardingVerify";
import { installHttpTransport } from "./transportInstall";
import { desktopHttpClientSeed } from "../shared/transport.mjs";
import { ArrowRight, CheckIcon } from "./onboardingUi";
import { Button } from "./Button";
import { ProcessPanel } from "./ProcessPanel";
import { Callout } from "./Callout";
import mantaMark from "./assets/manta-mark-128.png";

const ACCENT = "var(--accent)"; // the app's accent token (borders/tints)
const ACCENT_SOLID = "var(--accent-solid)"; // filled buttons (BET-409: darker in light for AA)
const DANGER = "var(--danger)";

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
                  style={{ background: step <= activeIdx ? ACCENT : "var(--border)" }}
                />
              )}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-label font-semibold transition-all shrink-0"
                style={
                  state === "inactive"
                    ? { background: "var(--card)", color: "var(--tx4)", border: "1.5px solid var(--border)" }
                    : state === "active"
                      ? {
                          background: ACCENT_SOLID,
                          color: "var(--on-accent)",
                          border: `1.5px solid ${ACCENT}`,
                          boxShadow: `0 0 0 4px var(--accent-bg)`,
                        }
                      : { background: ACCENT_SOLID, color: "var(--on-accent)", border: `1.5px solid ${ACCENT}` }
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
              className="text-meta text-center min-w-[60px]"
              style={{ color: isActive ? "var(--tx2)" : "var(--tx4)", fontWeight: isActive ? 500 : 400 }}
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
//   onDone — called when onboarding completes (success screen "Open manta").
export function Onboarding({ onDone }: { onDone: () => void }) {
  // Derive the resume point once from the current config so a quit-mid-flow
  // reopens at the first incomplete step. Deep-link pairing forces step 1.
  const [pos, setPos] = useState<OnboardingPosition>(() =>
    useStore.getState().pendingPairLink
      ? 1
      : resolveInitialStep(useStore.getState().configSnapshot()),
  );

  // Verification state (BET-421 §B). The ProcessPanel is driven by
  // `verifyProgress`; a failure populates `verifyError` with the stage +
  // message so the failure card can render the three actions.
  const [verifyProgress, setVerifyProgress] = useState<VerifyProgress | null>(null);
  const [verifyError, setVerifyError] = useState<{
    failedStage: VerifyStageIndex;
    message: string;
    labels: [string, string, string];
  } | null>(null);
  const [verifyElapsed, setVerifyElapsed] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Pre-flight for everything that runs AFTER a successful pair.
  //
  // Order is load-bearing: the transport swap MUST happen before
  // store.refresh(). On the SSH auto-claim path the credentials are persisted
  // by main and window.api is still the Electron preload bridge, which has no
  // syncSnapshot — so refresh() would throw before the swap ever happened, and
  // the wizard would never leave step 1.
  //
  // window.api.configGet() is what makes the freshly-minted boxToken visible
  // here; it exists on BOTH transports. In http mode it returns the manta
  // SERVER's config, which carries no pairing secrets, so the seed is null and
  // the already-installed transport is correctly left alone.
  const refreshAndInstallTransport = useCallback(async () => {
    const seed = desktopHttpClientSeed(await window.api.configGet());
    if (seed) installHttpTransport(seed);
    await useStore.getState().refresh();
  }, []);

  // The post-pair verify. Runs an ephemeral opencode session through three
  // named stages; on success the shell advances to "success", on failure
  // the failure card renders with Try again / Back to the provider step /
  // Copy diagnostics.
  const runVerify = useCallback(async () => {
    await refreshAndInstallTransport();
    // Resolve the connected provider label + the configured default model
    // so the stage labels name them. If the status probe fails or nothing
    // is connected, fall back to generic labels — the verify still runs.
    let providerLabel = "your provider";
    let modelLabel: string | undefined;
    try {
      const status = await window.api.opencodeProviderAuth({
        action: "status",
      });
      const cfg = useStore.getState().configSnapshot();
      const labels = pickVerifyLabels(status, cfg.defaultModel ?? null);
      if (labels) {
        providerLabel = labels.providerLabel;
        modelLabel = labels.modelLabel;
      }
    } catch {
      /* best-effort — verify with generic labels */
    }
    const stages = verifyStageLabels(providerLabel, modelLabel);
    setVerifyError(null);
    setVerifyElapsed(0);
    setVerifyProgress({ stage: 0, status: "running" });
    const outcome = await verifyOnboarding({
      api: window.api,
      providerLabel,
      modelLabel,
      onProgress: (p) => setVerifyProgress(p),
    });
    if (outcome.ok) {
      setVerifyProgress(null);
      setPos("success");
      return;
    }
    setVerifyProgress({ stage: outcome.failedStage, status: "error" });
    setVerifyError({
      failedStage: outcome.failedStage,
      message: outcome.message,
      labels: stages,
    });
  }, [refreshAndInstallTransport]);

  // Step 1 → step 2 (provider needed) OR step 1 → runVerify (provider
  // already connected). Detecting the latter before stepping forward keeps
  // the user from blinking through an empty step-2 frame.
  //
  // Failures are contained rather than propagated: this is invoked as
  // `void onPaired()`, so a rejection here is silent and freezes the wizard on
  // step 1 (BET pairing-stall bug). Pairing has already succeeded at this
  // point, so we advance regardless — ProvidersStep surfaces its own load
  // error if the box is still unreachable.
  const onPaired = useCallback(async () => {
    let connected = false;
    try {
      await refreshAndInstallTransport();
      connected = await hasConnectedProvider(window.api);
    } catch (e) {
      console.warn("[manta] post-pair pre-flight failed; advancing anyway:", e);
    }
    if (connected) {
      await runVerify();
    } else {
      setPos(2);
    }
  }, [refreshAndInstallTransport, runVerify]);

  // Step 2 → verify (provider connect just landed → run the verify).
  const onProviderContinue = useCallback(() => {
    void runVerify();
  }, [runVerify]);

  const goBack = () => setPos((p) => prevPosition(p));

  // BET-421 §C: skip / onboardingSkipped are deliberately NOT wired. A
  // model is mandatory; there is no skip button on any platform.

  // Deep-link pairing: a link that arrives WHILE onboarding is already open
  // must also jump to step 1.
  const pendingPairLink = useStore((s) => s.pendingPairLink);
  useEffect(() => {
    if (pendingPairLink) setPos(1);
  }, [pendingPairLink]);

  // BET-421 §F: move focus to the new step's heading on advance. The
  // refocus-on-error pattern already exists in these files; this is the
  // same idea applied when advancing. The step components own their own
  // <h2>; we focus the first heading inside the step body so a screen
  // reader / keyboard user lands on the new step's title.
  useEffect(() => {
    if (verifyProgress) return; // verify overlay owns focus while running
    const h2 = bodyRef.current?.querySelector("h2");
    if (h2 instanceof HTMLHeadingElement) {
      h2.setAttribute("tabindex", "-1");
      h2.focus();
    }
  }, [pos, verifyProgress]);

  // Tick the verify elapsed-time display once a second while running.
  useEffect(() => {
    if (!verifyProgress || verifyProgress.status !== "running") return;
    const t = setInterval(() => setVerifyElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [verifyProgress]);

  const isSuccess = pos === "success";
  const isVerifying = verifyProgress !== null && !verifyError;

  const copyVerifyDiagnostics = useCallback(async () => {
    if (!verifyError) return;
    const stageLabel = verifyError.labels[verifyError.failedStage] ?? "verification";
    const text = [
      "Manta onboarding verification failed",
      `Stage: ${verifyError.failedStage + 1} of ${verifyError.labels.length} — ${stageLabel}`,
      `Elapsed: ${verifyElapsed}s`,
      `Error: ${verifyError.message}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable; the text is also shown inline */
    }
  }, [verifyError, verifyElapsed]);

  return (
    <div className="fixed inset-0 z-50 bg-bg text-text flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-[720px] px-6 py-8">
        {/* Header: brand mark + progress rail (hidden on the success screen). */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-8">
            {/* The real brand mark (docs/brand/README.md: "The current
                onboarding 'logo' is a generic inline SVG and must be replaced
                with the Manta mark"). The PNG is the manta ray in the
                cyan→blue brand gradient on a transparent ground, so it reads
                on both the light and dark canvas — which is why the mark is
                NOT tinted by the theme here. onboardingUi's inline MantaMark
                stays for the mobile pair screen, where the shape is drawn in
                white on an accent circle and a gradient PNG would not work. */}
            <img
              src={mantaMark}
              alt=""
              aria-hidden="true"
              className="w-9 h-9"
              draggable={false}
            />
            <span className="text-title font-semibold tracking-tight">Manta</span>
          </div>
          {!isSuccess && <ProgressRail current={pos} />}
        </div>

        {/* Step body. `key` on the wrapper restarts the fade+slide animation on
            every position change. */}
        <div className="relative overflow-hidden" ref={bodyRef}>
          <div key={String(pos)} className="onboarding-step-enter">
            {isSuccess ? (
              <SuccessPanel onOpen={onDone} />
            ) : pos === 1 ? (
              <PairStep onPaired={() => void onPaired()} />
            ) : pos === 2 ? (
              <ProvidersStep onBack={goBack} onContinue={onProviderContinue} />
            ) : null}
          </div>
        </div>

        {/* Verification panel (BET-421 §B). Sits below the step body so it
            doesn't obscure the active step's controls. Mounted mid-verify
            and on failure; cleared on success. */}
        {verifyProgress && verifyError && (
          <div className="mt-6 space-y-4">
            <ProcessPanel
              stages={verifyError.labels}
              activeIndex={verifyError.failedStage}
              status="error"
              elapsedSeconds={verifyElapsed}
              logLines={[]}
              onCopyDiagnostics={copyVerifyDiagnostics}
            />
            <Callout tone="danger">{verifyError.message}</Callout>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runVerify()}
                className="px-4 py-2 rounded-sm text-body font-medium"
                style={{ background: ACCENT_SOLID, color: "var(--on-accent)" }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => {
                  setVerifyProgress(null);
                  setVerifyError(null);
                  setPos(2);
                }}
                className="px-4 py-2 rounded-sm text-body font-medium"
                style={{ border: `1px solid ${ACCENT}`, color: ACCENT }}
              >
                Back to the provider step
              </button>
              <button
                type="button"
                onClick={() => void copyVerifyDiagnostics()}
                className="px-4 py-2 rounded-sm text-body font-medium"
                style={{ border: `1px solid ${DANGER}`, color: DANGER }}
              >
                Copy diagnostics
              </button>
            </div>
          </div>
        )}
        {isVerifying && verifyProgress && (
          <div className="mt-6">
            <ProcessPanel
              stages={verifyStageLabels("your provider")}
              activeIndex={verifyProgress.stage}
              status={verifyProgress.status}
              elapsedSeconds={verifyElapsed}
              logLines={[]}
            />
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
        style={{ background: "var(--ok-bg)" }}
      >
        <CheckIcon className="w-7 h-7 text-ok" />
      </div>
      <h2 className="text-display font-semibold mb-2">You're all set!</h2>
      <p className="text-body text-text-muted leading-relaxed max-w-sm mx-auto mb-8">
        Your box is paired and a provider is connected. Start chatting with
        your AI assistant.
      </p>
      <Button tone="primary" block onClick={onOpen}>
        Open Manta
        <ArrowRight />
      </Button>
    </div>
  );
}
