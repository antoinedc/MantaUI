// Codex (ChatGPT subscription) seat rewrite — the `openai` half of V1
// `manta-accounts`. Only the identity changes: authorization, ChatGPT-Account-Id
// and the compute-residency header. URL and body are never touched.

const RESIDENCY_HEADER = "x-openai-internal-codex-residency";
const AUTH_CLAIM = "https://api.openai.com/auth";

/** Claims of a JWT (no signature check — we only read our own seat's token). */
export function jwtClaims(token: string): any {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

/** The Codex residency value for a token, or null (header removed). */
export function residencyFromToken(token: string): string | null {
  const claims = jwtClaims(token);
  const v = claims?.[AUTH_CLAIM]?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency;
  return typeof v === "string" && v && v !== "no_constraint" ? v : null;
}

/** A copy of `headers` carrying the seat's Codex identity. Nothing else changes. */
export function codexHeaders(headers: Headers, seat: { accessToken: string; accountId?: string }): Headers {
  const out = new Headers(headers);
  out.set("authorization", `Bearer ${seat.accessToken}`);
  if (seat.accountId) out.set("ChatGPT-Account-Id", seat.accountId);
  else out.delete("ChatGPT-Account-Id");
  const residency = residencyFromToken(seat.accessToken);
  if (residency) out.set(RESIDENCY_HEADER, residency);
  else out.delete(RESIDENCY_HEADER);
  return out;
}
