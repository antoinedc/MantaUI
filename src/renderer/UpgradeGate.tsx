// UpgradeGate.tsx — the blocking "upgrade your box" screen (OpenCode V2
// cutover, slice C4). Pure presentation: `hooks/useUpgradeGate.ts` decides what
// is true, `upgradeGate.ts` turns it into a `GateView`, this file paints it.
//
// It covers the whole window and is NOT dismissible — no ×, no Escape, no
// backdrop click. While a box migrates, every data route answers 503, so there
// is nothing behind it the user could usefully reach. The only exits are the
// states' own actions:
//   upgrade-box  → "Upgrade box" (raises the EXISTING confirm → box update flow)
//   failed       → Retry / Check again, Roll back (each shows its own outcome)
//   rolled_back  → "Download previous version"
// plus "Copy details" for whoever is helping.
//
// Every button here does something and says what happened (AGENTS.md: never
// stub a control): a press shows a spinner, then success or the error text.

import { useState, type ReactNode } from "react";
import { Check, Circle, Loader2, X } from "lucide-react";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { ConfirmModal } from "./ConfirmModal";
import { getMantaPreload } from "./preloadAccess";
import mantaMark from "./assets/manta-mark-128.png";
import {
  DESKTOP_DOWNLOAD_URL,
  describeGateDetails,
  formatEtaSeconds,
  stepFraction,
  type ActionOutcome,
  type GateView,
} from "./upgradeGate";
import type { UpgradeStep } from "../shared/api";

export type UpgradeGateProps = {
  view: GateView;
  /** Raise the existing "Update Manta Server?" confirm (App.tsx owns the flow). */
  onUpgradeBox: () => void;
  onRetry: () => void;
  onRollback: () => void;
};

// ---- small pieces ---------------------------------------------------------

/** A determinate bar, or an indeterminate sweep when `fraction` is null. */
function Bar({
  fraction,
  label,
  size = "md",
}: {
  fraction: number | null;
  label: string;
  size?: "sm" | "md";
}) {
  const h = size === "md" ? "h-2" : "h-1.5";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className={`${h} w-full rounded-full bg-accent/20 overflow-hidden relative`}
    >
      {fraction === null ? (
        <div className="absolute h-full manta-sweep rounded-full bg-accent" />
      ) : (
        <div className="h-full bg-accent transition-[width]" style={{ width: `${fraction * 100}%` }} />
      )}
    </div>
  );
}

function StepIcon({ status }: { status: UpgradeStep["status"] }) {
  switch (status) {
    case "done":
      return <Check size={14} aria-hidden="true" className="text-ok" />;
    case "running":
      return <Loader2 size={14} aria-hidden="true" className="animate-spin text-accent" />;
    case "failed":
      return <X size={14} aria-hidden="true" className="text-danger" />;
    default:
      return <Circle size={10} aria-hidden="true" className="text-text-faint" />;
  }
}

function StepList({ steps }: { steps: UpgradeStep[] }) {
  return (
    <ol className="space-y-3" aria-label="Upgrade steps">
      {steps.map((s) => {
        const fraction = s.status === "running" ? stepFraction(s) : null;
        const p = s.progress;
        const measured =
          s.status === "running" && p && p.numerator !== undefined && p.denominator !== undefined
            ? `${p.numerator} / ${p.denominator}`
            : null;
        return (
          <li key={s.id} data-step={s.id} data-status={s.status} className="flex items-start gap-3">
            <span className="mt-[3px] w-4 shrink-0 flex justify-center">
              <StepIcon status={s.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={`text-body ${
                  s.status === "pending" ? "text-text-faint" : s.status === "failed" ? "text-danger" : "text-text"
                }`}
              >
                {s.label}
              </div>
              {s.status === "running" && (
                <div className="mt-2 space-y-1">
                  <Bar fraction={fraction} label={`${s.label} progress`} size="sm" />
                  {(p?.label || measured) && (
                    <div className="text-meta text-text-faint truncate">
                      {[p?.label, measured].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              )}
              {s.status === "failed" && s.error && (
                <div className="mt-1 text-meta text-danger break-words">{s.error}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The spinner → success/error text next to a pressed button. */
function OutcomeLine({ outcome, okText }: { outcome: ActionOutcome; okText: string }) {
  if (outcome.phase === "idle" || outcome.phase === "pending") return null;
  return (
    <div
      role={outcome.phase === "error" ? "alert" : "status"}
      className={`text-meta break-words ${outcome.phase === "error" ? "text-danger" : "text-ok"}`}
    >
      {outcome.phase === "ok" ? okText : outcome.message}
    </div>
  );
}

function Spin() {
  return <Loader2 size={14} aria-hidden="true" className="animate-spin" />;
}

/** "Copy details" with a visible result on BOTH branches. */
function CopyDetails({ view }: { view: GateView }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const text = describeGateDetails(view);
  if (!text) return null;
  const copy = async () => {
    try {
      const preload = getMantaPreload();
      if (preload?.clipboardWriteText) await preload.clipboardWriteText(text);
      else await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex items-center gap-3">
      <Button tone="ghost" onClick={() => void copy()}>
        Copy details
      </Button>
      {state === "copied" && (
        <span role="status" className="text-meta text-ok">
          Copied to the clipboard
        </span>
      )}
      {state === "failed" && (
        <span role="alert" className="text-meta text-danger">
          Couldn't copy — the clipboard isn't available here
        </span>
      )}
    </div>
  );
}

function GateFrame({ title, titleId, children }: { title: string; titleId: string; children: ReactNode }) {
  return (
    <div
      // z-50 like Onboarding; the confirm modal portals later in the DOM at the
      // same level so it paints above this.
      className="fixed inset-0 z-50 bg-bg text-text flex items-center justify-center overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="upgrade-gate"
    >
      <div className="w-full max-w-[560px] px-6 py-8">
        <div className="inline-flex items-center gap-3 mb-8">
          <img src={mantaMark} alt="" aria-hidden="true" className="w-9 h-9" draggable={false} />
          <span className="text-title font-semibold tracking-tight">Manta</span>
        </div>
        <h2 id={titleId} className="text-title font-semibold mb-4">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

// ---- the gate ---------------------------------------------------------------

const TITLE_ID = "upgrade-gate-title";

export function UpgradeGate({ view, onUpgradeBox, onRetry, onRollback }: UpgradeGateProps) {
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [download, setDownload] = useState<"idle" | "opening" | "opened" | { error: string }>("idle");

  if (view.kind === "hidden") return null;

  if (view.kind === "upgrade-box") {
    const p = view.progress;
    return (
      <GateFrame title="Your box needs to be upgraded" titleId={TITLE_ID}>
        <p className="text-body text-text-faint mb-5">
          This version of Manta needs a newer box. The upgrade moves your conversation history onto the new
          engine; it stops any agent turn that is running, and the box restarts while it happens.
        </p>
        {view.updating ? (
          <div className="space-y-2" role="status">
            <div className="flex items-center gap-2 text-body">
              <Spin />
              {view.restarting ? "Restarting the box…" : p?.label ? p.label : "Updating the box…"}
            </div>
            <Bar
              fraction={!view.restarting && p && p.total > 0 ? p.step / p.total : null}
              label="Box update progress"
            />
            {!view.restarting && p && (
              <div className="text-meta text-text-faint">
                Step {p.step} of {p.total}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {view.error && (
              <Callout tone="danger">
                <span role="alert">The update didn't start: {view.error}</span>
              </Callout>
            )}
            <Button tone="primary" size="lg" onClick={onUpgradeBox}>
              {view.error ? "Try again" : "Upgrade box"}
            </Button>
          </div>
        )}
      </GateFrame>
    );
  }

  if (view.kind === "waiting") {
    return (
      <GateFrame title="Your box is upgrading" titleId={TITLE_ID}>
        <p className="text-body text-text-faint mb-5">
          The box is moving to a new version and can't take requests right now. This screen updates by itself.
        </p>
        <div role="status" className="space-y-2">
          <div className="flex items-center gap-2 text-body">
            <Spin /> Waiting for the box…
          </div>
          <Bar fraction={null} label="Waiting for the box" />
        </div>
      </GateFrame>
    );
  }

  if (view.kind === "running") {
    const eta = formatEtaSeconds(view.etaSeconds);
    const overallPct = Math.round(view.overall * 100);
    return (
      <GateFrame title="Upgrading your box" titleId={TITLE_ID}>
        <p className="text-body text-text-faint mb-5">
          Please keep Manta open. Running agent turns were stopped, and conversations are unavailable until this
          finishes.
        </p>
        <div className="mb-6 space-y-1">
          <Bar fraction={view.overall} label="Overall upgrade progress" />
          <div className="flex justify-between text-meta text-text-faint">
            <span>{overallPct}% complete</span>
            {eta && <span>{eta}</span>}
          </div>
        </div>
        <StepList steps={view.steps} />
      </GateFrame>
    );
  }

  if (view.kind === "failed") {
    const busy = view.retry.phase === "pending" || view.rollback.phase === "pending";
    return (
      <GateFrame title="The upgrade couldn't finish" titleId={TITLE_ID}>
        <Callout tone="danger">
          <div role="alert" className="space-y-1">
            <div className="break-words">{view.message}</div>
            {view.disk && <div className="font-medium">{view.disk}.</div>}
            {view.failedStep === "preflight" && (
              <div className="text-text-faint">Nothing was changed — your box is exactly as it was.</div>
            )}
          </div>
        </Callout>
        <div className="my-6">
          <StepList steps={view.steps} />
        </div>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              tone="primary"
              onClick={onRetry}
              loading={view.retry.phase === "pending"}
              disabled={!view.canRetry || busy}
              title={view.retryDisabledReason ?? undefined}
            >
              {view.retry.phase === "pending" ? (
                <>
                  <Spin /> {view.retryLabel === "Retry" ? "Retrying…" : "Checking…"}
                </>
              ) : (
                view.retryLabel
              )}
            </Button>
            {view.canRollback && (
              <Button
                tone="danger"
                onClick={() => setConfirmRollback(true)}
                loading={view.rollback.phase === "pending"}
                disabled={busy}
              >
                {view.rollback.phase === "pending" ? (
                  <>
                    <Spin /> Rolling back…
                  </>
                ) : (
                  "Roll back"
                )}
              </Button>
            )}
          </div>
          <OutcomeLine outcome={view.retry} okText={view.retryLabel === "Retry" ? "Retry requested" : "Checking again…"} />
          <OutcomeLine outcome={view.rollback} okText="Roll-back requested" />
          {!view.canRetry && view.retryDisabledReason && (
            <div className="text-meta text-text-faint">{view.retryDisabledReason}</div>
          )}
          <CopyDetails view={view} />
        </div>
        <ConfirmModal
          open={confirmRollback}
          title="Roll the box back?"
          body="The box returns to the previous version with your original history, which the upgrade did not change. Conversations started since the upgrade are exported to a file instead. You will then need to reinstall the previous desktop version."
          confirmLabel="Roll back"
          confirmTone="danger"
          onConfirm={() => {
            setConfirmRollback(false);
            onRollback();
          }}
          onCancel={() => setConfirmRollback(false)}
        />
      </GateFrame>
    );
  }

  // rolled_back
  const openDownload = async () => {
    setDownload("opening");
    try {
      await window.api.openExternal(DESKTOP_DOWNLOAD_URL);
      setDownload("opened");
    } catch (e) {
      setDownload({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <GateFrame title="Your box was rolled back" titleId={TITLE_ID}>
      <p className="text-body text-text-faint mb-5">
        The box is back on the previous version with your original history. This version of the desktop app no
        longer matches it — reinstall the previous desktop version to keep working.
      </p>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button tone="primary" onClick={() => void openDownload()} loading={download === "opening"}>
            {download === "opening" ? (
              <>
                <Spin /> Opening…
              </>
            ) : (
              "Download previous version"
            )}
          </Button>
        </div>
        {download === "opened" && (
          <div role="status" className="text-meta text-ok">
            Opened the download page in your browser.
          </div>
        )}
        {typeof download === "object" && (
          <div role="alert" className="text-meta text-danger break-words">
            Couldn't open the download page: {download.error}. Go to {DESKTOP_DOWNLOAD_URL}
          </div>
        )}
        <CopyDetails view={view} />
      </div>
    </GateFrame>
  );
}
