// ConnectProvider.tsx — subscription-provider connect card (BET-312).
//
// The single shared connect-flow component for Codex, Kimi, and Claude
// (in-app, OAuth device flow / API-key paste). Consumed by stage 3 from both
// the Settings card (BET-314) and the onboarding rewrite (BET-315); this
// file is the only implementation, and it intentionally does nothing else.
//
// State machine — exactly the transitions the issue calls for, no extras:
//
//   mount -> starting -> (waiting | needsCode | needsKey) -> applying -> done | failed
//
//   waiting        device-code OAuth (Codex). Shows URL + instructions + a
//                  copyable code; polls status until connected or 5 min.
//   needsCode      paste-back OAuth (browser variant, deliberately never
//                  selected by the server's resolveAuthMethod). Same UX as
//                  waiting, but no poll — the user submits the code.
//   needsKey       API-key path (Kimi, plus the fallback when resolveAuthMethod
//                  returns null). One password input + optional "Get a key"
//                  link to the registry-supplied console URL.
//   applying       restart + 30s poll. confirmRestart=true gates step 1
//                  behind a confirm bar; false starts the restart immediately.
//
// Pure helpers (connectPhaseLabel, parseDeviceCode, isPollExpired) live in
// chatUtils.ts so every "what does this phase mean?" / "has the poll
// expired?" decision pins against a unit test. This file is intentionally
// close to render-only: the state machine, two polling effects, and one
// input component are the only non-render code.
//
// No provider id, label, or console URL is hardcoded here — all of it
// arrives via props (id, label) or the `status` action (console). See the
// server-side SUBSCRIPTION_PROVIDERS table in subscriptionProviders.mjs.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { OpencodeProviderAuthRequest } from "../shared/types";
import {
  connectPhaseLabel,
  isPollExpired,
  parseDeviceCode,
  type ConnectPhase,
} from "./chatUtils";
import { CopyButton } from "./CopyButton";

// Poll cadences (BET-312): 3s for both the device-code wait and the
// post-restart readiness poll. The caps (5 min / 30 s) are intentionally
// separate and live as constants here so a future tuning pass touches one
// place, not three.
const DEVICE_POLL_INTERVAL_MS = 3_000;
const DEVICE_POLL_LIMIT_MS = 5 * 60 * 1_000;
const RESTART_POLL_INTERVAL_MS = 3_000;
const RESTART_POLL_LIMIT_MS = 30_000;

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
  confirmRestart = false,
}: {
  id: string;
  label: string;
  onDone: (connected: boolean) => void;
  onCancel: () => void;
  confirmRestart?: boolean;
}): JSX.Element {
  const [phase, setPhase] = useState<ConnectPhase>({ kind: "starting" });
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
  // three shapes that drive the next state directly. Errors fall back to
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
  }, [id, safeSetPhase]);

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

  // Restart + readiness poll (applying). confirmRestart=true gates step 1
  // behind a confirm bar that the user must explicitly approve; once
  // approved (or when the prop is false), the restart fires and the 30s
  // poll drives the transition to `done` / `failed`. The 30s cap is what
  // catches a mistyped API key: the write succeeds, but the re-read is the
  // only proof the credential is real.
  useEffect(() => {
    if (phase.kind !== "applying") return;
    if (confirmRestart && !phase.restartConfirmed) return;
    let cancelled = false;
    const startedAt = Date.now();
    (async () => {
      try {
        await window.api.opencodeRestart();
      } catch {
        /* poll below will catch a no-op restart on a reachable box */
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
    // `phase.restartConfirmed` only exists on the `applying` variant; the
    // ternary narrows `phase` for the access and the `null` branch keeps
    // the deps array a uniform value list (the false branch never reads
    // the field).
  }, [phase.kind, phase.kind === "applying" ? phase.restartConfirmed : null, confirmRestart, id, safeSetPhase]);

  // done is terminal — fire onDone exactly once. Mounted-check guards the
  // case where setPhase({kind:"done"}) races with unmount.
  useEffect(() => {
    if (phase.kind === "done") onDone(true);
  }, [phase.kind, onDone]);

  const retry = useCallback(() => {
    safeSetPhase({ kind: "starting" });
  }, [safeSetPhase]);

  return (
    <div className="rounded-md border bg-bg-elev px-3 py-2 text-[12px] space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-text">Connect {label}</span>
        <span className="text-text-faint">{connectPhaseLabel(phase)}</span>
        <button
          onClick={onCancel}
          className="ml-auto px-1.5 rounded text-text-faint hover:text-text-muted text-[14px]"
          title="Close"
        >
          ×
        </button>
      </div>

      {phase.kind === "starting" && (
        <div className="text-text-muted">Preparing sign-in…</div>
      )}

      {phase.kind === "waiting" && (
        <WaitingBlock url={phase.url} instructions={phase.instructions} />
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
        <div className="space-y-1.5">
          {phase.consoleUrl && (
            <a
              href={phase.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted underline decoration-dotted text-[11px]"
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

      {phase.kind === "applying" && confirmRestart && !phase.restartConfirmed && (
        <div className="flex items-center gap-2 bg-bg-soft border border-border rounded p-2">
          <span className="flex-1 text-text-muted">
            Restart opencode now to apply? (interrupts active sessions)
          </span>
          <button
            onClick={() => safeSetPhase({ kind: "applying", restartConfirmed: true })}
            className="px-2 py-1 bg-accent/20 border border-accent rounded text-text"
          >
            Apply Now
          </button>
          <button
            onClick={onCancel}
            className="px-2 py-1 border border-border rounded text-text-muted"
          >
            Apply Later
          </button>
        </div>
      )}

      {phase.kind === "applying" &&
        (!confirmRestart || phase.restartConfirmed) && (
          <div className="text-text-muted">Restarting opencode…</div>
        )}

      {phase.kind === "done" && (
        <div className="text-green-400">Connected.</div>
      )}

      {phase.kind === "failed" && (
        <div className="space-y-1.5">
          <div className="text-red-400 break-words">{phase.message}</div>
          <button
            onClick={retry}
            className="px-2 py-1 border border-border rounded text-text-muted hover:text-text"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// Device-code block: instructions verbatim + a clickable URL + a copyable
// code (when one is present in the instructions). Matches the OAuth shape
// the server reports: "oauth-auto" only ships the URL + instructions, the
// device code is a token embedded inside the instructions string that
// parseDeviceCode extracts.
function WaitingBlock({
  url,
  instructions,
}: {
  url: string;
  instructions: string;
}) {
  const code = parseDeviceCode(instructions);
  return (
    <div className="space-y-1">
      <div className="text-text">{instructions || "Open the URL below on any device."}</div>
      {url && (
        <div className="flex items-center gap-1.5 min-w-0">
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
      {code && (
        <div className="flex items-center gap-1.5">
          <code className="font-mono text-text bg-bg px-1.5 py-0.5 rounded">{code}</code>
          <CopyButton text={code} />
        </div>
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
      // Only clear on success — the parent's state machine will replace the
      // phase and remount this component; for a 401 / bad-response path the
      // value persists so the user can edit it instead of re-pasting.
      if (canSubmit) setValue((v) => v);
      setSubmitting(false);
    }
  };
  return (
    <div className="space-y-1">
      <label className="block text-text-faint text-[11px]">{label}</label>
      <div className="flex flex-wrap gap-1.5">
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
          className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 font-mono text-text outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="shrink-0 px-2 py-1 rounded border disabled:opacity-40 border-border text-text-muted hover:text-text"
        >
          {submitting ? "…" : submitLabel}
        </button>
      </div>
      {error && <div className="text-red-400 text-[11px] break-words">{error}</div>}
    </div>
  );
});
