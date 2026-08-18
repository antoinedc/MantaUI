// updateCheck.ts — the ONE shared "check for updates" (stage 3, BET-1098).
//
// Settings → About button and App.tsx's check-on-connect used to run their own
// copies of the same two-leg check (autoUpdateCheck + serverUpdateCheck). The
// spec lifts that into a single implementation that runs BOTH legs in parallel,
// builds the canonical UpdateTarget[] via `buildUpdateTargets`, stores it in
// the store, and returns it. Two callers, one code path — they can never
// disagree.
//
// The 15s timeout stays on the server leg: a wedged box must not spin the
// Settings button (or the on-connect check) forever.

import { buildUpdateTargets } from "../shared/updateTargets.mjs";
import type { UpdateTarget } from "../shared/types";
import { useStore } from "./store";

export async function refreshUpdateTargets(opts: {
  clientVersion?: string | null;
  serverVersion?: string | null;
} = {}): Promise<UpdateTarget[]> {
  // A hung check must never leave the caller spinning forever with no way out.
  // Each leg resolves-or-rejects, but a box whose server wedges before answering
  // would await indefinitely — so bound the server leg with a timeout and treat
  // expiry as a failed check rather than a never-ending wait.
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });

  const serverLeg =
    typeof window.api.serverUpdateCheck === "function"
      ? withTimeout(window.api.serverUpdateCheck(), 15_000)
      : Promise.resolve(null);

  // `Promise.allSettled`, not `all`: a failure of one leg must still report the
  // other. A box that is unreachable says nothing about whether the desktop has
  // an update waiting.
  const [desktop, server] = await Promise.allSettled([
    window.api.autoUpdateCheck(),
    serverLeg,
  ]);

  // autoUpdateCheck never rejects by contract (main resolves `{error}` instead),
  // so a rejection here means the bridge itself is missing — report it as
  // unsupported rather than as an update failure.
  const desktopCheck =
    desktop.status === "fulfilled"
      ? desktop.value
      : { supported: false, available: false, version: null };
  // Rejected, or timed out — indistinguishable at this level and both mean
  // "we couldn't get an answer", not "up to date". buildUpdateTargets maps
  // null to a server target with no available update.
  const serverCheck = server.status === "fulfilled" ? server.value : null;

  const targets = buildUpdateTargets({
    desktopCheck,
    serverCheck,
    clientVersion: opts.clientVersion ?? null,
    serverVersion: opts.serverVersion ?? null,
  });
  useStore.getState().setUpdateTargets(targets);
  return targets;
}
