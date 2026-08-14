// src/server/forge/sinks.mjs — the forge + push PROGRESS sinks (BET-798, spec
// §6.2).
//
// A background job's progress report can name sinks beyond the default `ui`.
// This module implements the two that touch the forge:
//
//   `forge` — upsert ONE comment on the linked pull request or issue, in
//             place, so a live checklist never duplicates. Idempotent by a
//             HIDDEN topic marker — this is precisely Renovate's
//             *ensure-comment-by-topic* pattern, and it is the whole reason
//             the comment stays single. One API write per change (debounced
//             by the caller's throttle, if any).
//
//   `push`  — nothing on `working`. On `blocked`/`failed`: an immediate
//             notification. On `done`: an informational one that follows the
//             normal desktop-first escalation. Both route straight through the
//             EXISTING notification router (fireNotify) — no second delivery
//             path.
//
// Both are wired in index.mjs; the pure decision logic lives here and is fully
// unit-testable.

// The hidden marker appended to a forge-sink comment. A stable string the
// ensure-by-topic logic searches for; a zero-width char up front keeps it
// invisible in the rendered comment. Never user-facing copy (Rule 3).
export const FORGE_TOPIC_PREFIX = "@forge-progress";

export function topicMarker(topic) {
  return `<!-- ${FORGE_TOPIC_PREFIX}:${topic} -->`;
}

// Body is a forge-sink comment for this topic when it carries the marker.
export function isForgeComment(body, topic) {
  return typeof body === "string" && body.includes(topicMarker(topic));
}

// The body we want to ensure. The marker is hidden at the tail.
export function forgeCommentBody(topic, text) {
  return `${text}\n\n${topicMarker(topic)}`;
}

// Pure decision: given the comments already on the PR/issue and the body we
// want to ensure, does this create or update, and which comment?
// Returns {kind:"create", body} | {kind:"update", id, body}.
export function planForgeComment(comments, { topic, text }) {
  const body = forgeCommentBody(topic, text);
  const existing = (comments ?? []).find((c) => isForgeComment(c?.body, topic));
  if (existing?.id != null) return { kind: "update", id: existing.id, body };
  return { kind: "create", body };
}

/**
 * Ensure a single comment by topic on a PR/issue. Lists existing comments,
 * then creates or updates the one carrying the topic marker — never a second
 * copy. All forge I/O is injected (in production the GitHub adapter's comment
 * methods).
 *
 * @param {object} input
 * @param {object} input.repo  { owner, repo }
 * @param {number} input.number  the PR or issue number
 * @param {string} input.topic  the stable topic (e.g. the job id)
 * @param {string} input.text  the live checklist text
 * @param {(repo, number) => Promise<{data: Array<{id: any, body: string}>}>} input.listComments
 * @param {(repo, number, body: string) => Promise<{data: {id?: any}}>} input.createComment
 * @param {(repo, number, commentId, body: string) => Promise<unknown>} input.updateComment
 * @returns {Promise<{ok: true, updated: boolean, id: any}>}
 */
export async function ensureCommentByTopic({
  repo,
  number,
  topic,
  text,
  listComments,
  createComment,
  updateComment,
}) {
  const list = await listComments(repo, number);
  const plan = planForgeComment(list.data, { topic, text });
  if (plan.kind === "create") {
    const created = await createComment(repo, number, plan.body);
    return { ok: true, updated: false, id: created?.data?.id ?? null };
  }
  // updateComment carries `number` because GitLab's MR notes are iid-scoped:
  // GitHub addresses a note by a global id but GitLab needs both the MR iid and
  // the note id. The contract is `(repo, number, commentId, body)` on both.
  await updateComment(repo, number, plan.id, plan.body);
  return { ok: true, updated: true, id: plan.id };
}

// ---------------------------------------------------------------------------
// push sink — map a progress record to a notification, or nothing on working
// ---------------------------------------------------------------------------

/**
 * Map a progress record to the push message it earns, or null when nothing
 * should fire. Pure:
 *   - working → null (progress is ambient, never interrupts).
 *   - blocked / failed → an URGENT (immediate/blocking-tier) notification.
 *   - done → an INFORMATIONAL notification following desktop-first escalation.
 *
 * @param {object} record  the merged progress record {state, label, ...}
 * @returns {{title: string, message: string, urgent: boolean, sessionID: string|null} | null}
 */
export function pushSinkAction(record) {
  if (!record) return null;
  const state = record.state;
  if (state === "working") return null;
  const label = record.label || "A background job";
  const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
  if (state === "done") {
    return { title: "Background job done", message: label, urgent: false, sessionID };
  }
  if (state === "failed") {
    return { title: "Background job failed", message: label, urgent: true, sessionID };
  }
  if (state === "blocked") {
    return { title: "Needs your input", message: label, urgent: true, sessionID };
  }
  return null;
}
