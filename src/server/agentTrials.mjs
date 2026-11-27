// Architect v2, Stage 1 (docs/superpowers/specs/2026-11-27-architect-v2.md §3.3): trial runs of a drafted agent.
//
// The Architect drafts an agent and runs it on 1–3 sample tasks in a throwaway copy of a project before proposing it. The
// server runs the cases (headless internal sessions, never a sidebar row), records what happened, and later checks, as FACTS,
// that the trial ran on exactly the draft that is proposed and that the Architect's verdicts quote the transcripts.
// Whether a case passed is the Architect's judgement; nothing here knows what a good agent is.

import { createHash } from "node:crypto";

/**
 * The hash of a draft's complete resulting file set: `{ "agent.md": <text>, "skills/<name>/<path>": <text>, … }`. ONE function,
 * used by the trial tools and by `agent_propose`, so "the trial ran on this exact draft" is a byte comparison.
 */
export const draftHash = (bundle) =>
  createHash("sha256")
    .update(JSON.stringify(Object.keys(bundle).sort().map((k) => [k, bundle[k]])))
    .digest("hex");

/** The files of `a` and `b` (two `{ path: text }` maps) that differ, sorted. */
export function differingFiles(a, b) {
  const paths = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...paths].filter((p) => a?.[p] !== b?.[p]).sort();
}
