// TEMP DIAG — silent-blank probe. Remove when the blank-bug is diagnosed.
//
// The renderer forwards window.onerror, unhandledrejection, and every
// console.error (including the ErrorBoundary's `[error-boundary]` log) to the
// main process, which writes them to the terminal you launched MantaUI from.
// Devtools closes the loop on "whole app blank, nothing in console": if a
// render throw / async rejection / boundary catch fires, it now lands in the
// terminal even when devtools shows nothing (or the root has already gone
// blank).
export function installBlankProbe(preload: unknown): void {
  const p = (preload ?? null) as {
    reportRendererLog?: (kind: string, message: string, stack?: string) => void;
  } | null;
  if (!p?.reportRendererLog) return;
  const report = (kind: string, message: string, stack?: string) => {
    try {
      p.reportRendererLog!(kind, String(message), stack);
    } catch {
      /* main gone — nothing to forward to */
    }
  };

  window.addEventListener("error", (e) => {
    report("window.onerror", e.message ?? String(e.error ?? ""), e.error?.stack);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report("unhandledrejection", r instanceof Error ? r.message : String(r), r?.stack);
  });

  // Patch console.error to also ship to the terminal. Guarded so we never
  // recurse: the forward is fire-and-forget and doesn't call console.*.
  const origError = console.error.bind(console);
  const patched = (...args: unknown[]) => {
    let message = "";
    let stack: string | undefined;
    for (const a of args) {
      if (a instanceof Error) {
        message += (message ? " " : "") + a.message;
        stack = a.stack;
      } else {
        try {
          message += (message ? " " : "") + (typeof a === "string" ? a : JSON.stringify(a));
        } catch {
          message += " [unserializable]";
        }
      }
    }
    report("console.error", message, stack);
    origError(...args);
  };
  console.error = patched as typeof console.error;
}
