// draft.mjs — the box-owned draft review store (BET-793, spec §3.4①).
//
// THE PORTABILITY DECISION. GitHub has a native pending-review concept (create
// a review with no `event`, it sits in PENDING, then submit). GitLab has NO
// equivalent — every comment POST publishes immediately and there is no
// batching in its REST API. So the box owns the draft: comments accumulate in
// this durable store, and "submit" flushes them in ONE operation. GitHub's
// native pending review becomes an optimisation we may or may not use, not the
// architecture. The pending bar renders identically regardless of forge — that
// is the visible payoff of the box-side buffer.
//
// One draft per `repoKey + prNumber`, persisted atomically (jsonStore.mjs).
//
//   Draft = { key, repoKey, number, headSha, verdict, body,
//             comments: DraftComment[], stale, updatedAt }
//   DraftComment = { id, path, line, side, startLine, body }
//
// `verdict` is "approve" | "request_changes" | "comment" | null (the shared
// ReviewVerdict vocabulary in src/shared/forge.mjs — no second enum).
//
// Invalidation on head movement: if the PR's head SHA moves, the line anchors
// may no longer be valid. We DO NOT discard the user's writing — keep the
// draft, mark `stale: true`, and let the renderer warn. Losing typed comments
// is unforgivable; showing a warning is not.
//
// Shape mirrors the other durable stores (secrets.mjs / schedule.mjs): a
// shared read/write helper from jsonStore.mjs, injected I/O for tests, and a
// `publish` on change so a connected client can refresh.

import { randomBytes } from "node:crypto";
import { statePath } from "../../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "../jsonStore.mjs";

const STORE_PATH = statePath("forge-drafts.json");

// The only review verdicts the box-buffered draft can carry. Deliberately the
// shared `ReviewVerdict` vocabulary from src/shared/forge.mjs
// ("approved" | "changes_requested" | "commented" | "pending") — minus
// "pending", which is a *review state*, not a draft action. A draft is never
// already-pending; it holds one of the three postable verdicts or null (no
// verdict yet). No second enum is defined anywhere (issue §Hygiene).
const VERDICTS = new Set(["approved", "changes_requested", "commented"]);

// A forge-neutral review-comment anchor. `side` is the renderer's "new"|"old"
// (the adapter maps it onto the forge's word — GitHub "RIGHT"/"LEFT"). `line`
// is required; `startLine` is the multi-line highlight start (optional). The
// old GitHub `position` field (offset from the hunk header) is retired — never
// built on.
const SIDES = new Set(["new", "old"]);

export async function loadDrafts(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed?.drafts) ? parsed.drafts : [];
}

export async function saveDrafts(drafts, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify({ drafts }, null, 2));
}

function draftKey(repoKey, number) {
  return `${repoKey}#${number}`;
}

function genId() {
  return randomBytes(6).toString("hex");
}

// ---- Pure helpers (tested) ---------------------------------------------------

/**
 * Find the draft for a repo+PR in a loaded store, or null.
 * @param {Array} drafts
 * @param {string} repoKey
 * @param {number} number
 */
export function findDraft(drafts, repoKey, number) {
  const key = draftKey(repoKey, number);
  return (Array.isArray(drafts) ? drafts : []).find((d) => d.key === key) ?? null;
}

// Validate + normalise a caller-supplied anchor into { path, line, side,
// startLine }. Returns null when the anchor is unusable (never coerces a bad
// anchor into a forged one — unknown input rejected loudly, module invariant).
export function normalizeAnchor(comment) {
  if (!comment || typeof comment !== "object") return null;
  const path = typeof comment.path === "string" ? comment.path.trim() : "";
  if (!path) return null;
  const line = comment.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  const side = comment.side ?? "new";
  if (!SIDES.has(side)) return null;
  const out = { path, line, side };
  if (comment.startLine != null) {
    if (typeof comment.startLine !== "number" || !Number.isInteger(comment.startLine) || comment.startLine < 1) {
      return null;
    }
    out.startLine = comment.startLine;
  }
  return out;
}

// ---- Store operations (injected I/O + publish) -------------------------------

async function loadDraft(repoKey, number, load) {
  const drafts = await load();
  return { drafts, draft: findDraft(drafts, repoKey, number) };
}

function newDraft(repoKey, number, headSha) {
  return {
    key: draftKey(repoKey, number),
    repoKey,
    number,
    headSha: typeof headSha === "string" && headSha ? headSha : "",
    verdict: null,
    body: "",
    comments: [],
    stale: false,
    updatedAt: Date.now(),
  };
}

/**
 * Read the current draft for a repo+PR (null when none exists).
 * @param {string} repoKey
 * @param {number} number
 * @param {{ load?: typeof loadDrafts }} [deps]
 */
export async function getDraft(repoKey, number, { load = loadDrafts } = {}) {
  const { draft } = await loadDraft(repoKey, number, load);
  return draft;
}

/**
 * Add (/create) or edit one draft comment. An empty body is rejected. A
 * comment WITH an existing id edits that comment in place; without one it is
 * appended (assigned a fresh id). `headSha` stamps the draft's head on first
 * comment so a later head movement can be detected.
 *
 * @returns {Promise<{ ok: true, draft: object } | { ok: false, error: string }>}
 */
export async function putComment(
  repoKey,
  number,
  headSha,
  comment,
  { load = loadDrafts, save = saveDrafts, publish } = {},
) {
  const body = typeof comment?.body === "string" ? comment.body.trim() : "";
  if (!body) return { ok: false, error: "comment body is required" };
  const anchor = normalizeAnchor(comment);
  if (!anchor) return { ok: false, error: "invalid comment anchor" };

  const { drafts, draft } = await loadDraft(repoKey, number, load);
  const target = draft ?? newDraft(repoKey, number, headSha);
  if (!draft) drafts.push(target);

  if (typeof comment.id === "string" && comment.id) {
    const idx = target.comments.findIndex((c) => c.id === comment.id);
    if (idx === -1) return { ok: false, error: "comment not found" };
    target.comments[idx] = { ...target.comments[idx], ...anchor, body };
  } else {
    target.comments.push({ id: genId(), ...anchor, body });
  }
  target.updatedAt = Date.now();

  await save(drafts);
  publish?.({ kind: "forge-draft.updated", payload: { repoKey, number } });
  return { ok: true, draft: target };
}

/**
 * Remove a draft comment by id. No-op when the comment (or draft) does not
 * exist.
 * @returns {Promise<{ ok: true, draft: object | null }>}
 */
export async function deleteComment(
  repoKey,
  number,
  commentId,
  { load = loadDrafts, save = saveDrafts, publish } = {},
) {
  const { drafts, draft } = await loadDraft(repoKey, number, load);
  if (!draft || typeof commentId !== "string" || !commentId) return { ok: true, draft };
  const before = draft.comments.length;
  draft.comments = draft.comments.filter((c) => c.id !== commentId);
  if (draft.comments.length === before) return { ok: true, draft };
  draft.updatedAt = Date.now();
  await save(drafts);
  publish?.({ kind: "forge-draft.updated", payload: { repoKey, number } });
  return { ok: true, draft };
}

/**
 * Set the draft's review verdict (+ optional body). `verdict` may be null to
 * clear. Creates the draft if it does not exist (stamping headSha) so a verdict
 * can be set before any comment.
 */
export async function setVerdict(
  repoKey,
  number,
  headSha,
  { verdict = null, body },
  { load = loadDrafts, save = saveDrafts, publish } = {},
) {
  if (verdict != null && !VERDICTS.has(verdict)) {
    return { ok: false, error: `invalid verdict "${verdict}"` };
  }
  const { drafts, draft } = await loadDraft(repoKey, number, load);
  const target = draft ?? newDraft(repoKey, number, headSha);
  if (!draft) drafts.push(target);
  target.verdict = verdict ?? null;
  if (body !== undefined) target.body = typeof body === "string" ? body : "";
  target.updatedAt = Date.now();
  await save(drafts);
  publish?.({ kind: "forge-draft.updated", payload: { repoKey, number } });
  return { ok: true, draft: target };
}

/**
 * Mark a draft stale (the PR head moved beyond what we anchored to) and keep
 * its content. Idempotent — returns the draft, clearing nothing.
 */
export async function markDraftStale(repoKey, number, { load = loadDrafts, save = saveDrafts, publish } = {}) {
  const { drafts, draft } = await loadDraft(repoKey, number, load);
  if (!draft || draft.stale) return draft;
  draft.stale = true;
  draft.updatedAt = Date.now();
  await save(drafts);
  publish?.({ kind: "forge-draft.updated", payload: { repoKey, number } });
  return draft;
}

/**
 * Clear the draft after a SUCCESSFUL submit. Only called by the submit path on
 * success — a failed submit leaves the draft intact and recoverable.
 */
export async function clearDraft(repoKey, number, { load = loadDrafts, save = saveDrafts, publish } = {}) {
  const drafts = await load();
  const idx = drafts.findIndex((d) => d.key === draftKey(repoKey, number));
  if (idx === -1) return { ok: true };
  drafts.splice(idx, 1);
  await save(drafts);
  publish?.({ kind: "forge-draft.updated", payload: { repoKey, number } });
  return { ok: true };
}
