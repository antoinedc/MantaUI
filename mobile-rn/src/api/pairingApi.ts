// pairingApi.ts — the impure box HTTP client for the RN app.
//
// Mirrors the web client's src/renderer/api/httpApi.ts claim + rpc contract, but
// against a caller-supplied serverUrl (the RN app has no same-origin fallback —
// it always knows its box URL from the pairing payload / stored credentials) and
// persisting the box_token in expo-secure-store instead of localStorage.
//
// All URL/payload/outcome LOGIC is delegated to the pure ../pure/claim.ts +
// ../pure/sessionList.ts modules; this file owns only fetch + Keychain side
// effects, so the testable surface stays pure.

import {
  classifyClaimResult,
  networkFailure,
  type ClaimResult,
} from "../pure/claim";
import { mapSessionRows, type SessionRowVM, type StatusMap } from "../pure/sessionList";
import { saveCredentials } from "./credentials";

/** Strip trailing slashes so "http://box/" and "http://box" behave identically. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Exchange a 6-digit pairing code for a box_token via POST <base>/auth/claim,
 * classify the outcome with the shared classifier, and on success persist
 * { serverUrl, boxId, boxToken } to the device keychain. Returns the typed
 * ClaimResult so the screen can render the exact failure inline.
 *
 * This is the RN equivalent of httpApi.claimAgainst — same request shape
 * (`{ pairing_code }` body, JSON), same "fetch rejects → networkFailure()"
 * transport-error mapping.
 */
export async function claimPairingCode(
  serverUrl: string,
  code: string,
): Promise<ClaimResult> {
  const base = trimBase(serverUrl);
  const url = `${base}/auth/claim`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: code }),
    });
  } catch {
    // fetch rejects (offline / DNS / TLS / bad URL) — no HTTP response reached us.
    return networkFailure();
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body (proxy/HTML error page) — leave null; classify by status */
  }
  const result = classifyClaimResult(res.status, body);
  if (result.ok) {
    await saveCredentials({ serverUrl: base, boxId: result.boxId, boxToken: result.boxToken });
  }
  return result;
}

/**
 * Thrown when the box rejects an authenticated request with HTTP 401
 * (missing/invalid box_token). The UI catches this to route back to pairing.
 */
export class AuthRequiredError extends Error {
  readonly status = 401 as const;
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthRequiredError";
    Object.setPrototypeOf(this, AuthRequiredError.prototype);
  }
}

/**
 * Authenticated JSON-RPC call: POST <base>/rpc/<channel> with a Bearer
 * box_token. Mirrors httpApi's rpc() — `{ args }` body, `{ result }`/`{ error }`
 * response envelope, 401 → AuthRequiredError.
 */
export async function rpc<T>(
  base: string,
  token: string,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  const res = await fetch(`${trimBase(base)}/rpc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ args }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  let json: { result?: unknown; error?: string } = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON body (proxy/HTML error) */
  }
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result as T;
}

/**
 * Fetch the read-only session list from the box's `tmux:list` channel and map it
 * to the FlatList view model. The status map is optional (the box streams
 * running/idle separately; the first render defaults every row to idle).
 */
export async function fetchSessionList(
  base: string,
  token: string,
  statuses?: StatusMap,
): Promise<SessionRowVM[]> {
  const raw = await rpc<unknown>(base, token, "tmux:list");
  return mapSessionRows(raw, statuses);
}
