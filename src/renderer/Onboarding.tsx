// Onboarding.tsx — full-screen M6.6 onboarding shell (BET-356, BET-421).
//
// Owns the full-screen container (no sidebar / header / footer), the progress
// rail (numbered dots + connecting lines), and fade+slide step transitions.
//
// The user-visible flow is two steps (Connect → Connect a provider). Model is
// global config (edited in Settings); no dedicated onboarding step for it.
//
// Onboarding's responsibility beyond the step machine:
//
//   Failure and resumption. Every failure shows a plain-language cause +
//   one way forward. The shell re-derives the resume point from config so
//   a quit-mid-flow reopens at the first incomplete step.
//
// There is NO model probe: onboarding installs the box (Step 1) and connects
// a provider (Step 2), then hands off. It never opens an ephemeral session or
// sends a probe prompt, so it never hangs on a slow/cold model or bills a
// turn before the user has done anything.
//
// Per-step bodies:
//   - Step 1 (Connect)          → PairStep.tsx (SSH picker primary, manual
//                                 disclosure secondary)
//   - Step 2 (Connect provider) → ProvidersStep.tsx (always shown; renders
//                                 already-connected providers ticked)
//
// There is no terminal success screen — step 2's own button ("Start using
// Manta") ends onboarding and hands control back to App.tsx.
//
// Those components own their own footers; the shell hides its generic
// footer and lets each step drive advancement (`onPaired` / `onContinue`).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  prevPosition,
  resolveInitialStep,
  type OnboardingPosition,
} from "./onboardingUtils";
import { useStore } from "./store";
import { PairStep } from "./PairStep";
import { ProvidersStep } from "./ProvidersStep";
import { installHttpTransport } from "./transportInstall";
import { desktopHttpClientSeed } from "../shared/transport.mjs";
import { CheckIcon } from "./onboardingUi";
import mantaMark from "./assets/manta-mark-128.png";

const ACCENT = "var(--accent)"; // the app's accent token (borders/tints)
const ACCENT_SOLID = "var(--accent-solid)"; // filled buttons (BET-409: darker in light for AA)

// Progress rail — one dot + connector per step.
function ProgressRail({ current }: { current: OnboardingPosition }) {
  const activeIdx = current;
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
//   onDone — called when onboarding completes (step 2's own "Start using Manta"
//            button). App.tsx drops back to the normal shell on onDone.
export function Onboarding({ onDone }: { onDone: () => void }) {
  // Derive the resume point once from the current config so a quit-mid-flow
  // reopens at the first incomplete step. Deep-link pairing forces step 1.
  const [pos, setPos] = useState<OnboardingPosition>(() =>
    useStore.getState().pendingPairLink
      ? 1
      : resolveInitialStep(useStore.getState().configSnapshot()),
  );

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

  // Step 1 → step 2. The provider step is always shown; on a box that
  // already has a provider connected, ProvidersStep displays it ticked and
  // the user chooses to add more or continue.
  //
  // Failures are contained rather than propagated: this is invoked as
  // `void onPaired()`, so a rejection here is silent and freezes the wizard on
  // step 1 (BET pairing-stall bug). Pairing has already succeeded at this
  // point, so we advance regardless — ProvidersStep surfaces its own load
  // error if the box is still unreachable.
  const onPaired = useCallback(async () => {
    try {
      await refreshAndInstallTransport();
    } catch (e) {
      console.warn("[manta] post-pair pre-flight failed; advancing anyway:", e);
    }
    setPos(2);
  }, [refreshAndInstallTransport]);

  // Step 2 is the last thing onboarding asks for: connecting a provider ends
  // the flow. There is no success screen — the provider step's own button
  // ("Start using Manta") hands control back to App.tsx.
  const onProviderContinue = useCallback(() => {
    onDone();
  }, [onDone]);

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
    const h2 = bodyRef.current?.querySelector("h2");
    if (h2 instanceof HTMLHeadingElement) {
      h2.setAttribute("tabindex", "-1");
      h2.focus();
    }
  }, [pos]);

  return (
    <div className="fixed inset-0 z-50 bg-bg text-text flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-[720px] px-6 py-8">
        {/* Header: brand mark + progress rail. */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-8">
            {/* The brand mark — the SAME artwork as the transcript loader
                (`MantaLoader.tsx`), and the only Manta mark that exists. The
                PNG is the manta ray in the cyan→blue brand gradient on a
                transparent ground, so it reads on both the light and dark
                canvas — which is why the mark is NOT tinted by the theme
                here. There is no inline-SVG alternative any more; see the
                note at the top of `onboardingUi.tsx`. */}
            <img
              src={mantaMark}
              alt=""
              aria-hidden="true"
              className="w-9 h-9"
              draggable={false}
            />
            <span className="text-title font-semibold tracking-tight">Manta</span>
          </div>
          <ProgressRail current={pos} />
        </div>

        {/* Step body. `key` on the wrapper restarts the fade+slide animation on
            every position change. */}
        <div className="relative overflow-hidden" ref={bodyRef}>
          <div key={String(pos)} className="onboarding-step-enter">
            {pos === 1 ? (
              <PairStep onPaired={() => void onPaired()} />
            ) : pos === 2 ? (
              <ProvidersStep onBack={goBack} onContinue={onProviderContinue} />
            ) : null}
          </div>
        </div>

      </div>
    </div>
  );
}
