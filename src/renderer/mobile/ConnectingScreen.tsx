import { useEffect, useState } from "react";

type Props = {
  // "relay" → connecting through the MantaUI relay (no host shown, it's the
  // default). "direct" → a self-hosted box; the host is surfaced in a pill.
  route: "relay" | "direct";
  // The host to show in the direct-mode pill (e.g. "box.example.com"). Ignored
  // for relay. Optional — omitted → no host text.
  host?: string;
  // Whether the connect attempt has failed (bootstrap threw a non-gate error).
  // Flips the screen to the error state with a Retry button.
  failed?: boolean;
  // Retry the connect (re-runs bootstrap). Shown on failure and after Cancel.
  onRetry: () => void;
  // Cancel a slow connect — returns to the setup/pairing screen. Shown once the
  // connect has been pending longer than SLOW_MS.
  onCancel?: () => void;
};

// After this long a still-pending connect shows a "taking longer than usual"
// hint + Cancel, so a hung network isn't an indefinite dead spinner.
const SLOW_MS = 8000;

/**
 * Full-screen connecting state for the mobile client. Shown while the initial
 * bootstrap (or a post-pair refresh) is in flight, so the user sees a clear
 * "Connecting to relay… / Connecting to remote box…" instead of a blank/empty
 * session list. Route (relay vs direct) comes from resolveConnectRoute over the
 * persisted server URL (setupLogic.ts).
 *
 * States:
 *   • connecting  → dual-ring spinner + route label (+ host pill for direct).
 *   • slow (8s+)  → adds a hint + Cancel.
 *   • failed      → error icon + plain-language cause + Retry.
 */
export function ConnectingScreen({ route, host, failed, onRetry, onCancel }: Props) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (failed) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [failed]);

  if (failed) {
    return (
      <div className="mobile">
        <div className="h-full flex flex-col items-center justify-center gap-5 px-10 text-center">
          <div
            className="grid place-items-center rounded-2xl"
            style={{
              width: 46,
              height: 46,
              background: "linear-gradient(140deg,#FF7A88,#7a1f2a)",
            }}
            aria-hidden
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 8v5M12 16.5v.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-text text-lg font-semibold">Couldn't reach your box</div>
            <div className="text-text-muted text-[13px] leading-relaxed max-w-[280px]">
              {route === "relay"
                ? "Your box didn't answer. It may be offline. Check it's running and try again."
                : "Couldn't open a direct connection. Check the server is reachable and try again."}
            </div>
          </div>
          <button
            className="mobile-tap mt-1 px-6 py-3 rounded-xl bg-accent-soft text-white font-semibold"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile">
      <div className="h-full flex flex-col items-center justify-center gap-6 px-10 text-center">
        <div className="relative grid place-items-center" style={{ width: 92, height: 92 }}>
          <Spinner />
          <div
            className="grid place-items-center rounded-[13px]"
            style={{
              width: 46,
              height: 46,
              background: "linear-gradient(140deg,#5A88FF,#1740AE)",
              boxShadow: "0 6px 18px rgba(90,136,255,.3)",
            }}
            aria-hidden
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 17c3-6 6-9 9-9s6 3 9 9"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-text text-lg font-semibold">
            {route === "relay" ? "Connecting to relay" : "Connecting to remote box"}
            <AnimatedDots />
          </div>
          <div className="text-text-muted text-[13px] leading-relaxed">
            {route === "relay"
              ? "Reaching your box through MantaUI."
              : "Opening a direct connection to your server."}
          </div>
        </div>

        {/* Host pill only for a custom/direct server — the relay is the default
            and needs no endpoint disclosure. */}
        {route === "direct" && host && (
          <div className="inline-flex items-center gap-2 rounded-full bg-bg-soft border border-border px-3.5 py-1.5 text-xs text-text-muted">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="4" y="4" width="16" height="7" rx="1.5" stroke="#A7B1C4" strokeWidth="1.6" />
              <rect x="4" y="14" width="16" height="6" rx="1.5" stroke="#A7B1C4" strokeWidth="1.6" />
              <circle cx="7.5" cy="7.5" r=".9" fill="#A7B1C4" />
              <circle cx="7.5" cy="17" r=".9" fill="#A7B1C4" />
            </svg>
            direct <span className="font-mono text-[11px] text-text-faint">{host}</span>
          </div>
        )}

        {slow && (
          <div className="flex flex-col items-center gap-2">
            <div className="text-text-faint text-xs max-w-[260px]">
              This is taking longer than usual. Make sure your box is online.
            </div>
            {onCancel && (
              <button
                className="mobile-tap mt-1 px-4 py-2 rounded-lg border border-border-strong text-text-muted text-[13px]"
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <span
        className="absolute inset-0 rounded-full"
        style={{
          border: "3px solid transparent",
          borderTopColor: "#5A88FF",
          animation: "manta-spin 0.9s linear infinite",
        }}
        aria-hidden
      />
      <span
        className="absolute rounded-full"
        style={{
          inset: 10,
          border: "3px solid transparent",
          borderRightColor: "rgba(90,136,255,.4)",
          animation: "manta-spin 1.4s linear infinite reverse",
        }}
        aria-hidden
      />
    </>
  );
}

function AnimatedDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v + 1) % 4), 350);
    return () => clearInterval(t);
  }, []);
  return <span className="inline-block w-[18px] text-left">{".".repeat(n)}</span>;
}
