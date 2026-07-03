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
import { mapTranscript, type TranscriptVM } from "../pure/transcript";
import {
  hydratePermission,
  hydrateQuestion,
  type PermissionReply,
  type PermissionVM,
  type QuestionVM,
} from "../pure/interaction";
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

/**
 * Fetch a chat session's transcript from the box's `opencode:messages` channel
 * (arg = opencode session id) and map it to the detail-screen view model. This
 * reuses the same generic `rpc()` helper as the session list — the box relays
 * it straight to opencode's `GET /session/{id}/message` (src/server/rpc.mjs →
 * opencode.listMessages). Read-only; live updates arrive over `/events`.
 */
export async function fetchTranscript(
  base: string,
  token: string,
  opencodeSessionId: string,
): Promise<TranscriptVM> {
  const raw = await rpc<unknown>(base, token, "opencode:messages", opencodeSessionId);
  return mapTranscript(raw);
}

/**
 * Send a prompt into a session via the box's `opencode:prompt` channel. The box
 * relays it to opencode's `POST /session/{id}/prompt_async` (src/server/
 * opencode.mjs sendPrompt), which builds the text part and scopes the turn to
 * the session's worktree. We pass only `{ sessionId, text }` — the box uses the
 * session's default model when none is supplied. The caller has already gated
 * `text` through the pure composer module (trimmed, non-empty, not mid-turn).
 */
export async function sendPrompt(
  base: string,
  token: string,
  sessionId: string,
  text: string,
): Promise<void> {
  await rpc<void>(base, token, "opencode:prompt", { sessionId, text });
}

/**
 * Abort the running generation for a session via `opencode:abort`. Idempotent
 * on the box; used by the composer's Stop button while a turn is running.
 */
export async function abortSession(
  base: string,
  token: string,
  sessionId: string,
): Promise<void> {
  await rpc<void>(base, token, "opencode:abort", sessionId);
}

/**
 * Fetch pending tool-approval permissions for a session (`opencode:permissions`,
 * scoped to the session so non-default-directory sessions return their pending
 * entries — see the server comment). Maps each raw row to the card VM via the
 * pure hydrator, dropping any without a usable id.
 */
export async function fetchPermissions(
  base: string,
  token: string,
  sessionId: string,
): Promise<PermissionVM[]> {
  const raw = await rpc<unknown>(base, token, "opencode:permissions", sessionId);
  if (!Array.isArray(raw)) return [];
  const out: PermissionVM[] = [];
  for (const row of raw) {
    const vm = hydratePermission((row ?? {}) as Record<string, unknown>);
    if (vm) out.push(vm);
  }
  return out;
}

/**
 * Reply to a permission request (`opencode:permission-reply`). `requestId` is
 * the `per_…` id the opencode reply API requires (carried on the card VM);
 * `reply` is one of once / always / reject. Scoped by sessionId so the reply
 * lands on the pending entry's workspace.
 */
export async function replyPermission(
  base: string,
  token: string,
  requestId: string,
  reply: PermissionReply,
  sessionId: string,
): Promise<void> {
  await rpc<void>(base, token, "opencode:permission-reply", {
    requestId,
    reply,
    sessionId,
  });
}

/**
 * Fetch pending Question-tool requests for a session (`opencode:questions`,
 * session-scoped). Maps each raw row to the card VM via the pure hydrator.
 */
export async function fetchQuestions(
  base: string,
  token: string,
  sessionId: string,
): Promise<QuestionVM[]> {
  const raw = await rpc<unknown>(base, token, "opencode:questions", sessionId);
  if (!Array.isArray(raw)) return [];
  const out: QuestionVM[] = [];
  for (const row of raw) {
    const vm = hydrateQuestion((row ?? {}) as Record<string, unknown>);
    if (vm) out.push(vm);
  }
  return out;
}

/**
 * Reply to a Question-tool request (`opencode:question-reply`). `requestId` is
 * the `que_…` id (carried on the card VM); `answers` is one string[] per
 * question, built by the pure `buildQuestionAnswers`.
 */
export async function replyQuestion(
  base: string,
  token: string,
  requestId: string,
  answers: string[][],
  sessionId: string,
): Promise<void> {
  await rpc<void>(base, token, "opencode:question-reply", {
    requestId,
    answers,
    sessionId,
  });
}

/**
 * Reject (dismiss) a Question-tool request without answering
 * (`opencode:question-reject`).
 */
export async function rejectQuestion(
  base: string,
  token: string,
  requestId: string,
  sessionId: string,
): Promise<void> {
  await rpc<void>(base, token, "opencode:question-reject", {
    requestId,
    sessionId,
  });
}
