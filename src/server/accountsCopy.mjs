// accountsCopy.mjs — the words of the Accounts surfaces, owned by the box
// (WS11 D4 / audit K7, K3, K5). Both clients render what this returns:
//   K7  an `accounts:*` error code → a sentence (never the raw code on a screen)
//   K3  an endpoint-register entry → its one-line state; the no-healthy-endpoint
//       verdict → its banner copy; the worst endpoint per provider
//   K5  a conversation's seat move → the notice sentence, the dial line, the
//       "history re-sent" figure
// Pure; no I/O. Time-relative text ("last success 5m ago") is worded at response
// time from the supplied `nowMs` — the surfaces that show it are polled.

import { endpointStateLabel, providerStateLabel } from "../shared/providerHealthLabel.mjs";
import { formatTokenCount } from "../shared/formatTokens.mjs";

/** The sentence for a class-1 `accounts:*` error code — never the raw code. */
export function accountsErrorMessage(code) {
  switch (code) {
    case "unknown-seat":
      return "That seat no longer exists. The list has been refreshed.";
    case "invalid-label":
      return "Names must be 1–40 characters, with no control characters.";
    case "live-seat":
      return "This is the login the box is using right now, so it can't be removed.";
    case "last-seat":
      return "This is the only login on this box — use Disconnect instead.";
    case "no-replacement":
      return "No other login is signed in and ready to take over, so this one can't be removed yet.";
    case "unknown-provider":
      return "That provider doesn't support several accounts.";
    case "login-failed":
      return "Sign-in failed. Try again.";
    case "duplicate-login":
      return "That login is already added.";
    case "different-org":
      return "That login belongs to a different organisation.";
    case "different-account":
      return "That isn't the account this seat belongs to. Sign in with the same account.";
    case "unknown-flow":
      return "That sign-in is no longer running. Try again.";
    default:
      return "That didn't work. Try again.";
  }
}

/** A result of the form `{error: <code>}` gains `message`; anything else passes through. */
export function withErrorMessage(result) {
  if (result && typeof result === "object" && typeof result.error === "string" && result.error && result.message === undefined) {
    return { ...result, message: accountsErrorMessage(result.error) };
  }
  return result;
}

/** The retry-cooldown minutes for a rate-limited entry; always ≥1, null when none. */
export function formatRetryMinutes(retryInMs) {
  return typeof retryInMs === "number" && retryInMs > 0 ? Math.max(1, Math.ceil(retryInMs / 60_000)) : null;
}

/** "just now" / "5m ago" / "3h ago" / "6d ago"; null for a missing time. */
export function formatAgeAt(ts, nowMs) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const delta = Math.max(0, nowMs - ts);
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The §W9 worst-state order for an endpoint register: dead refuses everything,
 * then the authoritative refusals, then rate-limited, degraded, unproven.
 */
export const ENDPOINT_STATE_BADNESS = Object.freeze({
  dead: 5,
  "not-found": 4,
  forbidden: 4,
  "rate-limited": 3,
  degraded: 2,
  unproven: 1,
});

/** One line for an endpoint's register detail: state · retry · reason · last success · attempts. */
export function formatEndpointStateLine(detail, nowMs) {
  if (!detail || typeof detail.state !== "string") return "";
  const parts = [endpointStateLabel(detail.state) ?? detail.state];
  const retryMin = formatRetryMinutes(detail.retryInMs);
  if (retryMin != null) parts.push(`retry in ${retryMin}m`);
  const status = detail.reason?.httpStatus;
  const errorName = detail.reason?.errorName;
  if (typeof status === "number" && Number.isFinite(status)) parts.push(`HTTP ${status}`);
  else if (typeof errorName === "string" && errorName) parts.push(errorName);
  const lastSuccess = formatAgeAt(detail.lastSuccessAt, nowMs);
  if (lastSuccess) parts.push(`last success ${lastSuccess}`);
  const attempts = typeof detail.attempts === "number" ? detail.attempts : null;
  const successes = typeof detail.successes === "number" ? detail.successes : null;
  if (attempts != null && attempts > 0) {
    const pct = Math.round(((successes ?? 0) / attempts) * 100);
    parts.push(`${attempts} attempt${attempts === 1 ? "" : "s"} · ${pct}% success in window`);
  }
  return parts.join(" · ");
}

/** The entries of `endpoints` ("providerID/modelID" → detail) that belong to `providerID`, keyed by model id. */
export function endpointStatesFor(endpoints, providerID) {
  const out = {};
  const prefix = `${providerID}/`;
  for (const [key, entry] of Object.entries(endpoints ?? {})) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry;
  }
  return out;
}

/** The worst register entry for a provider: `{key, modelId, entry}`, or null. A tie keeps the first. */
export function worstEndpoint(endpoints, providerID) {
  let worst = null;
  for (const [modelId, entry] of Object.entries(endpointStatesFor(endpoints, providerID))) {
    if (!worst || (ENDPOINT_STATE_BADNESS[entry.state] ?? 0) > (ENDPOINT_STATE_BADNESS[worst.entry.state] ?? 0)) {
      worst = { key: `${providerID}/${modelId}`, modelId, entry };
    }
  }
  return worst;
}

/**
 * `providerLines`: the worst endpoint per provider with its worded line. A provider
 * whose register is empty but has enabled models reads "Unproven" (key null).
 * @param {Record<string, object>} endpoints  the health engine's endpoint detail map
 * @param {Record<string, number>} [enabledCounts]  providerID → enabled model count
 */
export function providerLinesFor(endpoints, enabledCounts, nowMs) {
  const ids = new Set(Object.keys(endpoints ?? {}).map((k) => k.slice(0, Math.max(0, k.indexOf("/")))).filter(Boolean));
  for (const [id, n] of Object.entries(enabledCounts ?? {})) if (n > 0) ids.add(id);
  const out = {};
  for (const id of ids) {
    const worst = worstEndpoint(endpoints, id);
    if (worst) out[id] = { key: worst.key, stateLine: formatEndpointStateLine(worst.entry, nowMs) };
    else if ((enabledCounts?.[id] ?? 0) > 0) out[id] = { key: null, stateLine: "Unproven" };
  }
  return out;
}

/** The no-healthy-endpoint verdict's banner copy: what was excluded, why, and the way out. */
export function formatNoHealthyEndpointCopy(decision) {
  const excluded = Array.isArray(decision?.excluded) ? decision.excluded : [];
  if (excluded.length === 0) {
    return "Auto couldn't pick a healthy model. The turn was not sent; switch off Auto, reset health below, or pick a model to send.";
  }
  const why = decision?.excludedWhy ?? {};
  const named = excluded
    .map((key) => {
      const entry = why[key];
      if (!entry) return key;
      const bits = [];
      const ep = typeof entry.endpoint === "string" ? endpointStateLabel(entry.endpoint) : null;
      if (ep) bits.push(ep);
      const pv = typeof entry.provider === "string" ? providerStateLabel(entry.provider) : null;
      if (pv) bits.push(pv);
      return bits.length > 0 ? `${key} (${bits.join(", ")})` : key;
    })
    .join(", ");
  return `Auto couldn't pick a healthy model — ${named} excluded. The turn was not sent; switch off Auto, reset health below, or pick a model to send.`;
}

const nonEmpty = (s) => (typeof s === "string" && s.trim() !== "" ? s.trim() : null);

/** "seat was at its limit" / "to balance load" / the reason with separators as spaces; null when none. */
export function moveReasonText(reason) {
  const r = nonEmpty(reason);
  if (!r) return null;
  if (r === "exhausted") return "seat was at its limit";
  if (r === "load" || r === "balance") return "to balance load";
  return r.replace(/[-_]/g, " ");
}

/**
 * "Moved to Work · Seat 2 (Seat 1 at 91% of 5h)." — the parenthetical says why; a
 * cross-org move appends " History re-sent.". Unknown reasons and missing labels
 * degrade to the plain "Moved to X.".
 */
export function moveNoticeText({ fromLabel, toLabel, reason, trigger, crossOrg }) {
  const target = nonEmpty(toLabel) ?? "another seat";
  const origin = nonEmpty(fromLabel);
  let percentText = null;
  let windowName = null;
  if (trigger && Number.isFinite(trigger.pct)) {
    percentText = `${Math.round(Math.min(100, Math.max(0, trigger.pct)))}%`;
    if (trigger.kind === "weekly") windowName = "the weekly limit";
    else if (trigger.kind === "session") windowName = "5h";
  }
  const reasonKey = reason ?? "";
  let why = null;
  if (origin) {
    if (reasonKey === "unusable") why = `${origin} needed sign-in`;
    else if (reasonKey === "load" || reasonKey === "exhausted") {
      if (percentText) why = `${origin} at ${percentText}${windowName ? ` of ${windowName}` : ""}`;
      else why = reasonKey === "exhausted" ? `${origin} was at its limit` : `${origin} was near its limit`;
    }
  }
  const head = reasonKey === "manual" ? `Switched to ${target}` : `Moved to ${target}`;
  const sentence = why ? `${head} (${why}).` : `${head}.`;
  return crossOrg === true ? `${sentence} History re-sent.` : sentence;
}

/** The dial line without its age: "Moved from Seat 1 · seat was at its limit". */
export function moveLine({ from, fromLabel, reason }) {
  const origin = nonEmpty(fromLabel) ?? nonEmpty(from);
  const parts = [origin ? `Moved from ${origin}` : "Moved from another seat"];
  const why = moveReasonText(reason);
  if (why) parts.push(why);
  return parts.join(" · ");
}

/** "history re-sent: 12k" for a cross-org move that carries the figure, else null. */
export function resentText({ crossOrg, resentTokens }) {
  return crossOrg === true && typeof resentTokens === "number" ? `history re-sent: ${formatTokenCount(resentTokens)}` : null;
}

/** The three move fields every move payload gains. */
export function moveCopy(move) {
  return { text: moveNoticeText(move), line: moveLine(move), resentText: resentText(move) };
}
