// onboardingUi.tsx — shared React presentation primitives for the desktop
// onboarding flow. These are the pieces that were previously copy-pasted
// verbatim across Onboarding.tsx and the per-step bodies (the step-nav
// arrow/check/plus SVGs and the Back+Continue footer). Extracting them
// here kills the duplication-gate clones and gives every step one source
// of truth for the nav chrome. Pure step-model logic still lives in
// onboardingUtils.ts; this module owns only the small shared JSX.

import { Button } from "./Button";

// ── Brand mark ───────────────────────────────────────────────────────────────
//
// BET-421 §F: first-run used a PNG on desktop and an inline SVG on mobile.
// One mark for both. The two-arc manta shape is the same path the mobile
// SetupScreen already drew; rendering it with `currentColor` lets the
// caller pick accent/white without a second asset.

export function MantaMark({ className = "w-9 h-9" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        d="M3 17c3-6 6-9 9-9s6 3 9 9"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7 17c2-3.5 3.4-5 5-5s3 1.5 5 5"
        strokeWidth="2"
        strokeLinecap="round"
        opacity=".6"
      />
    </svg>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

export function ArrowRight({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function ArrowLeft({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function PlusIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ── Step footer (Back + primary Continue) ────────────────────────────────────
//
// Every onboarding step body that owns its own footer (Providers, Model) — and
// the shell's generic step-4 footer — renders the same Back-left / primary-right
// row. `continueDisabled` expresses the per-step gate (≥1 connected provider,
// a selected model); the shell's step-4 footer leaves it undefined (always
// enabled) and overrides the label via `continueLabel`.

export function StepFooter({
  onBack,
  onContinue,
  continueLabel = "Continue",
  continueDisabled = false,
}: {
  onBack: () => void;
  onContinue: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mt-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 px-4 py-3 rounded-sm text-body text-text-muted hover:text-text transition-colors"
      >
        <ArrowLeft />
        Back
      </button>
      <Button tone="primary" block type="button" onClick={onContinue} disabled={continueDisabled}>
        {continueLabel}
        <ArrowRight />
      </Button>
    </div>
  );
}
