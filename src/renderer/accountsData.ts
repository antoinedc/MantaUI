// ===== Multi-account & seats — renderer data plumbing =====
//
// The accounts slice (`ProviderView[]`) and the per-conversation seat cache live
// in the store; this module is the only thing that fills them. Both loads are
// PASSIVE refreshes (priming on connect, refetch on a bus hint, refetch when a
// popover opens), so a failure leaves the previous value in place — an absent
// seat view simply makes every consumer fall back to the plain provider
// snapshot. User-initiated actions (Use / Rename / Add / Remove) do NOT go
// through here: they await the RPC and report both branches themselves.

import type { SeatProviderId } from "../shared/types";
import { useStore } from "./store";

/** Refetch `accounts:list` into the store. Resolves false when the box has no
 *  such channel (older box) or the call failed; the slice is left untouched. */
export async function refreshAccounts(): Promise<boolean> {
  const api = window.api;
  if (!api?.accountsList) return false;
  try {
    const res = await api.accountsList();
    useStore.getState().setAccounts(Array.isArray(res?.providers) ? res.providers : []);
    return true;
  } catch {
    return false;
  }
}

/** Refetch the usage slice (`usage:list`). Same passive rules as above: a failure
 *  leaves the previous readings in place. */
async function refreshUsage(): Promise<boolean> {
  const api = window.api;
  if (!api?.usageList) return false;
  try {
    const list = await api.usageList();
    useStore.getState().setUsage(Array.isArray(list) ? list : []);
    return true;
  } catch {
    return false;
  }
}

/** After an account/seat was added: bring EVERY slice the Accounts list and the
 *  usage popover read up to date, and only resolve once they have landed — so
 *  the caller can close its panel knowing the new seat is already on screen and
 *  nobody has to refresh by hand. */
export async function refreshAccountsAndUsage(): Promise<boolean> {
  const [accounts] = await Promise.all([refreshAccounts(), refreshUsage()]);
  return accounts;
}

/** Where a seat now lives, read back from the store after a refresh. */
export function findSeatLabels(
  provider: SeatProviderId,
  seatId: string,
): { seatLabel: string; accountLabel: string; email: string | null } | null {
  const view = useStore.getState().accounts.find((p) => p.provider === provider);
  for (const account of view?.accounts ?? []) {
    const seat = account.seats.find((x) => x.id === seatId);
    if (seat) return { seatLabel: seat.label, accountLabel: account.label, email: seat.email };
  }
  return null;
}

/** Refetch one conversation's seat into the cache. `null` from the box (no
 *  assignment yet) is cached as null so the dial stops asking. */
export async function refreshSessionSeat(sessionId: string | null | undefined): Promise<void> {
  const api = window.api;
  if (!sessionId || !api?.accountsSessionSeat) return;
  try {
    const seat = await api.accountsSessionSeat({ sessionId });
    useStore.getState().setSessionSeat(sessionId, seat ?? null);
  } catch {
    // Keep the cached value; the next open / `accounts.moved` asks again.
  }
}

// ---- "open Settings → Accounts" bridge ------------------------------------
//
// The popover's "Manage seats" / "Fix" / "Other subscriptions" links ask App
// (which owns the Settings modal) to open on the Accounts section — the same
// `manta-open-settings` window CustomEvent the model menu uses — and say which
// provider to expand. The Settings modal may not be mounted yet when this
// fires, so the provider is also parked in a module variable the seats panel
// consumes on mount.

let pendingFocus: SeatProviderId | null = null;

export function openAccountsSettings(provider?: SeatProviderId): void {
  pendingFocus = provider ?? null;
  window.dispatchEvent(
    new CustomEvent("manta-open-settings", { detail: { section: "accounts", provider } }),
  );
}

/** True (once) when this provider was the one a link asked to open. */
export function consumeAccountsFocus(provider: SeatProviderId): boolean {
  if (pendingFocus !== provider) return false;
  pendingFocus = null;
  return true;
}

/** Test seam. */
export function clearAccountsFocus(): void {
  pendingFocus = null;
}
