// unpair.ts (desktop) — the "Remove box" wire call (BET-357 §2).
//
// The desktop Settings → Connection → "Remove box" action invokes the
// `authUnpair` IPC channel, which lands here. We DELETE <serverUrl>/auth/revoke
// with the current box_token as a Bearer header. The box rotates its identity
// in place (see src/server/auth.mjs revoke) and the OLD token is dead from
// that instant.
//
// The IPC handler in src/main/index.ts ALWAYS clears the local config entry
// (serverUrl / boxId / boxToken / projects) regardless of the remote outcome —
// the unreachable-box path must still succeed locally per the spec. This
// function returns ONLY the classified remote outcome so the caller can decide
// whether to surface a "remote revocation didn't happen" note.

import { classifyUnpairHttp } from "../shared/unpair.mjs";
import type { UnpairOutcome } from "../shared/unpair.mjs";

/**
 * Perform the wire call to remove this box from the device that holds the
 * current box_token. Pure of side effects (no FS, no config mutation) — the
 * IPC handler is responsible for the local config clear so the policy lives
 * in exactly one place.
 *
 * @param input        { serverUrl, boxToken } — the box's direct-HTTPS URL
 *                     and the current device-held bearer token. The renderer
 *                     reads both from the store at click time; no caching
 *                     here.
 * @param fetchImpl    Injectable for tests; defaults to global fetch.
 * @param now          Injectable clock (currently unused — reserved for
 *                     future timing instrumentation).
 * @returns the classified {@link UnpairOutcome}. A wrong token, a rate limit,
 *          an unreachable host, etc. are all normal `{ ok:false }` results —
 *          this function never throws for an expected auth/transport failure.
 *          Unexpected exceptions (e.g. fetch throwing for a non-network
 *          reason) ARE propagated so the IPC handler can decide how to
 *          handle them; the caller will translate the throw into a
 *          `{ ok:false, kind:"network" }` so the Settings panel still has a
 *          structured outcome to render.
 */
export async function unpairBox(
  input: { serverUrl: string; boxToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UnpairOutcome> {
  const serverUrl = (input?.serverUrl ?? "").trim();
  const boxToken = (input?.boxToken ?? "").trim();
  if (serverUrl === "" || boxToken === "") {
    // Local drift: no URL or token cached → can't even attempt the call.
    // Surface as "network" so the Settings panel doesn't have to branch on a
    // distinct "missing creds" shape — the unreachable-box fallback is the
    // right UX either way (clear locally, show the note).
    return { ok: false, kind: "network", message: "" };
  }
  const url = `${serverUrl.replace(/\/+$/, "")}/auth/revoke`;
  let status: number | null = null;
  let networkError: string | null = null;
  try {
    const res = await fetchImpl(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${boxToken}`,
      },
    });
    status = res.status;
  } catch (e) {
    // fetch rejected (offline / DNS / TLS / connection refused / timeout).
    // Map to a generic network tag; the classifier collapses all fetch-level
    // failures into one outcome for the UI.
    networkError = e instanceof Error ? e.message : String(e);
  }
  return classifyUnpairHttp({ status, networkError });
}
