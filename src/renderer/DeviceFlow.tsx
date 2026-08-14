// DeviceFlow.tsx — the SHARED device-code screen (BET-796).
//
// The two-step device sign-in ("open this link, then enter the code") is ONE
// design that appears in two places: ConnectProvider's `waiting` phase (the
// subscription-provider card) and the GitHub clone flow ([S5]). This is the
// single implementation of that screen's step block, so the provider card and
// the fresh-box clone flow cannot drift.
//
// Design rules from §8.3 ([S5]):
//   - Two NUMBERED steps; the numbering is part of the copy.
//   - `device_code` (the internal id) is never shown — only `user_code`.
//   - The code is copied automatically (best-effort; see `autoCopied`) and the
//     UI says so inside the code box — the user pastes, not retypes.
//   - The verification URL is NOT decorated with the code — the user types it
//     separately so a typo can be highlighted.
//
// This is purely presentational: the parent owns the countdown, the Cancel
// button, the 3s poll / 5-min cap, and the clipboard write. The step block
// here is the one shared visual.

import { useState } from "react";

function StepLabel({ n, children }: { n: number; children: React.ReactNode }) {
  // .stepn — 10px mono uppercase --tx4. The one place text-micro is correct.
  return (
    <div className="text-[10px] font-mono uppercase tracking-[0.07em] text-text-quiet mb-2">
      Step {n} — {children}
    </div>
  );
}

export function DeviceCodeSteps({
  url,
  displayUrl,
  code,
  autoCopied,
}: {
  /** The verification URL the user opens (github.com/login/device). */
  url: string;
  /** The host-less URL shown as the accent link. */
  displayUrl: string;
  /** The user_code the user enters — NEVER the device_code. */
  code: string;
  /** True once the code was auto-copied to the clipboard; shows the in-box note. */
  autoCopied?: boolean;
}) {
  const [urlCopied, setUrlCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const copyUrl = () => {
    void navigator.clipboard?.writeText(url).then(
      () => setUrlCopied(true),
      () => {},
    );
  };
  const copyCode = () => {
    void navigator.clipboard?.writeText(code).then(
      () => setCodeCopied(true),
      () => {},
    );
  };
  const note =
    autoCopied === true && !codeCopied ? "copied to clipboard" : codeCopied ? "copied to clipboard" : undefined;
  return (
    <div>
      <StepLabel n={1}>open this link</StepLabel>
      <div className="flex items-center gap-2 mb-4">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[13px] text-accent-tx hover:underline truncate"
        >
          {displayUrl}
        </a>
        <button
          type="button"
          onClick={copyUrl}
          className="shrink-0 text-[11px] border border-border rounded-full px-3 py-1 text-text-muted hover:text-text"
        >
          {urlCopied ? "copied" : "copy"}
        </button>
      </div>
      <StepLabel n={2}>enter the code</StepLabel>
      <div className="flex items-center gap-2 font-mono text-[22px] font-semibold tracking-[0.16em] text-text bg-inset border border-border rounded-md px-4 py-3">
        <span className="min-w-0">{code}</span>
        <button
          type="button"
          onClick={copyCode}
          className="shrink-0 text-[11px] border border-border rounded-full px-3 py-1 text-text-muted hover:text-text -ml-1"
        >
          {codeCopied ? "copied" : "copy"}
        </button>
        {note && (
          <small className="ml-auto font-sans text-[11px] font-normal tracking-normal text-text-faint">
            {note}
          </small>
        )}
      </div>
    </div>
  );
}
