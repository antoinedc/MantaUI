// src/server/forge/rules.mjs — the rules ENGINE (BET-798).
//
// The payoff of the forge integration: *issue labeled → box wakes → a matched
// rule fires → an agent runs in its own worktree → a draft PR opens*. This
// module is the third step — it turns a verified, deduped, filtered inbound
// webhook (webhooks.mjs) into a dispatch. It is the only issue in the project
// that can START AN AGENT FROM AN EXTERNAL EVENT, so the guards here are not
// decoration.
//
// It is almost entirely composition, by design: matched rule in, existing
// engine called. Nothing is spun up here that does not already exist:
//   - `delegate`   → the EXISTING delegate engine (`startJob`). No second job
//                    runner. The prompt comes from the rule with `{{url}}` /
//                    `{{title}}` substituted; its default is DEFAULT_DELEGATE_PROMPT
//                    (shared with the work-inbox — one default, not two).
//   - `notify`     → the EXISTING notification router (`fireNotify`). No
//                    second notification path.
//   - `inbox`      → invalidate the inbox cache so the item appears. No
//                    dispatch, no wake.
//
// Four guards, all here:
//   - OFF BY DEFAULT. `forgeRulesEnabled`, default false. Dormant when off.
//   - The concurrency cap IS the blast radius. The delegate engine enforces
//     five concurrent running jobs and REFUSES rather than queues. A label
//     applied to forty issues must produce five jobs and thirty-five clean
//     refusals. We do NOT add a queue — the refusal is the safety property.
//   - Autonomous jobs open drafts, never merge. Enforced in code (the ship
//     path only opens drafts for autonomous jobs) and restated in the prompt
//     text (AUTONOMOUS_JOB_CONTRACT).
//   - Ignore self-caused events (the box's own token/actor as sender), and
//     refuse fork-originated payloads. Redelivery dedupe already lives in
//     webhooks.mjs (isRedelivery) — not repeated here.
//
// Like delegate.mjs and capabilities.mjs, everything is dependency-injected so
// the tests need no live tmux, opencode or network.

import { matchRule, parseRules } from "../../shared/forgeRules.mjs";

// The default delegate prompt when a `delegate` rule carries no `prompt`.
// Shared with the work-inbox (which delegates from a click through the SAME
// rules file), so there is exactly ONE default, not two. Mirror of the
// grammar's canonical example.
export const DEFAULT_DELEGATE_PROMPT = "Complete {{url}}. Open a draft PR.";

// The autonomous-job contract appended to every forge-triggered delegate
// prompt. The safety line: an autonomous job may open a DRAFT pull request but
// may never merge. Restated in the prompt text so the rule is visible to the
// job, not just enforced in code.
export const AUTONOMOUS_JOB_CONTRACT =
  "You are running autonomously from a forge event. When you finish, open a DRAFT " +
  "pull request for your work. You may NEVER merge, force-push, or touch any other checkout.";

// Substitute the fixed placeholders in a rule prompt. Pure. Unknown
// placeholders (already rejected by the validator at file-write time) are left
// untouched defensively rather than doubled.
export function substitutePrompt(prompt, { url, title } = {}) {
  if (typeof prompt !== "string") return prompt;
  return prompt
    .replace(/\{\{url\}\}/g, url ?? "")
    .replace(/\{\{title\}\}/g, title ?? "");
}

// ---------------------------------------------------------------------------
// Guard + normalisation (pure) — raw GitHub delivery → forge event
// ---------------------------------------------------------------------------

// A forge event is the normalised shape the rules match on:
//   { type: "issue.labeled"|"checks.failed"|"review.requested",
//     label?, branch?, title?, url?, actor?, repo?, fork? }
// `actor`/`repo`/`fork` are guard inputs consumed by the engine, not rule
// conditions. matchRule reads only {type, label, branch}.

// checks.failed is the noisiest to normalise: GitHub fires both check_run and
// legacy status events, and only a *failed/completed* check is a rule event.
function normalizeChecksFailed(event, payload) {
  if (event === "check_run") {
    const cr = payload.check_run;
    if (!cr || cr.status !== "completed") return null;
    const c = cr.conclusion;
    // success / neutral / skipped are not failures.
    if (c === "success" || c === "neutral" || c === "skipped" || c == null) return null;
    const repo = payload.repository;
    const branch = cr.check_suite?.head_branch ?? null;
    return {
      type: "checks.failed",
      ...(typeof branch === "string" && branch ? { branch } : {}),
      // No PR link on a raw check_run — fall back to the repo page.
      ...(typeof repo?.html_url === "string" ? { url: repo.html_url } : {}),
      title: typeof cr.name === "string" && cr.name ? `check ${cr.name}` : "a check failed",
      actor: payload.sender?.login ?? null,
      repo: typeof repo?.full_name === "string" ? repo.full_name : null,
      fork: false,
    };
  }
  // Legacy commit status event.
  const state = payload.state;
  if (state !== "failure" && state !== "error") return null;
  const branches = Array.isArray(payload.branches) ? payload.branches : [];
  const branch =
    branches.find((b) => b?.commit?.sha === payload.sha)?.name ?? branches[0]?.name ?? null;
  const repo = payload.repository;
  return {
    type: "checks.failed",
    ...(typeof branch === "string" && branch ? { branch } : {}),
    ...(typeof repo?.html_url === "string" ? { url: repo.html_url } : {}),
    title: typeof payload.context === "string" && payload.context ? `check ${payload.context}` : "a check failed",
    actor: payload.sender?.login ?? null,
    repo: typeof repo?.full_name === "string" ? repo.full_name : null,
    fork: false,
  };
}

/**
 * Normalise a raw GitHub webhook delivery into a forge event, or null when the
 * delivery is not one a rule can fire on (a non-matching action, a ping, a
 * check that did not fail).
 *
 * @param {{ event?: string, payload?: any }} input
 *   event   — the X-GitHub-Event header ("issues" | "check_run" | "status" |
 *             "pull_request" | "ping")
 *   payload — the parsed webhook body
 * @returns {{ type: string, label?: string, branch?: string, title?: string,
 *             url?: string, actor?: string|null, repo?: string|null, fork?: boolean } | null}
 */
export function normalizeEvent({ event, payload } = {}) {
  if (!payload || typeof payload !== "object") return null;
  switch (event) {
    case "issues": {
      if (payload.action !== "labeled") return null;
      const label = payload.label?.name;
      const issue = payload.issue;
      if (typeof label !== "string" || !label) return null;
      return {
        type: "issue.labeled",
        label,
        ...(typeof issue?.title === "string" ? { title: issue.title } : {}),
        ...(typeof issue?.html_url === "string" ? { url: issue.html_url } : {}),
        actor: payload.sender?.login ?? null,
        repo: typeof payload.repository?.full_name === "string" ? payload.repository.full_name : null,
        fork: false,
      };
    }
    case "check_run":
    case "status":
      return normalizeChecksFailed(event, payload);
    case "pull_request": {
      if (payload.action !== "review_requested") return null;
      const pr = payload.pull_request;
      if (!pr) return null;
      const repoFull = typeof payload.repository?.full_name === "string" ? payload.repository.full_name : null;
      // A PR whose head comes from a different repository (or a fork) is
      // fork-originated.
      const fork = Boolean(pr.head?.repo?.fork) || (repoFull != null && pr.head?.repo?.full_name !== repoFull);
      return {
        type: "review.requested",
        ...(typeof pr.head?.ref === "string" ? { branch: pr.head.ref } : {}),
        ...(typeof pr.title === "string" ? { title: pr.title } : {}),
        ...(typeof pr.html_url === "string" ? { url: pr.html_url } : {}),
        actor: payload.sender?.login ?? null,
        repo: repoFull,
        fork,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The engine — injected composition
// ---------------------------------------------------------------------------

/**
 * Create the box-side rules engine. Handles a verified inbound forge event and
 * dispatches the matched rule through injected engines. All I/O is injected so
 * the tests need no live tmux, opencode or network.
 *
 * @param {object} deps
 * @param {() => boolean} [deps.enabled] — true only when forgeRulesEnabled (default off).
 * @param {(repoKey: string) => Promise<{ok: boolean, yaml?: string}>} [deps.loadRules]
 *   Load a repo's rules source (default reads the box-side registry).
 * @param {(event: any, rules: any) => any} [deps.match] — matchRule.
 * @param {(input: {prompt: string, repoKey: string, event: any, rule: any}) => Promise<{ok?: boolean, error?: string}>} [deps.startDelegate]
 *   The EXISTING delegate engine. A refusal (`ok:false`) is the cap/guard and
 *   is recorded, never queued.
 * @param {(input: {repoKey: string, event: any, rule: any, message: string}) => Promise<unknown>} [deps.notify]
 *   The EXISTING notification router (push.fireNotify).
 * @param {(input: {repoKey: string, event: any}) => Promise<unknown>} [deps.invalidateInbox]
 *   Invalidate the inbox cache so the item appears.
 * @param {(input: {repoKey: string, event: any, rule: any, reason: string}) => Promise<unknown>} [deps.recordRefusal]
 *   Persist a refusal (cap reached, fork, …) — never a queue.
 * @param {string|null} [deps.self] — the box's own forge identity; events
 *   whose actor matches are ignored (self-caused).
 * @returns {{ handleEvent: (input: {hook: any, headers: any, event: string, payload: any}) => Promise<any>, dispatchEvent: (repoKey: string, event: any) => Promise<any> }}
 */
export function createRulesEngine({
  enabled = () => false,
  loadRules = defaultLoadRules,
  match = matchRule,
  startDelegate = async () => ({ ok: true }),
  notify = async () => {},
  invalidateInbox = async () => {},
  recordRefusal = async () => {},
  self = null,
} = {}) {
  async function handleEvent({ hook, headers, event, payload } = {}) {
    if (!enabled()) return { handled: false, reason: "disabled" };
    const repoKey = hook?.repoKey ?? null;
    if (!repoKey) return { handled: false, reason: "no repo" };

    const ev = normalizeEvent({ event, payload, headers });
    if (!ev) return { handled: false, reason: "not a rule event" };

    return dispatchEvent(repoKey, ev);
  }

  /**
   * The single dispatch path, shared by the webhook ingest (via handleEvent)
   * and the polling fallback (poller.mjs feeds normalised forge events here).
   * Guards (fork / self-caused) + match + verb dispatch. `event` is a
   * normalised forge event — never a raw forge payload.
   *
   * @param {string} repoKey
   * @param {object} ev a normalised forge event
   * @returns {Promise<{handled: boolean, reason?: string, error?: string|null, verb?: string}>}
   */
  async function dispatchEvent(repoKey, ev) {
    const loaded = await loadRules(repoKey);
    if (!loaded?.ok) return { handled: false, reason: "no rules" };
    const parsed = parseRules(loaded.yaml ?? "");
    if (!parsed.ok || !parsed.rules) return { handled: false, reason: "invalid rules" };

    // Guard: refuse fork-originated payloads.
    if (ev.fork) {
      await recordRefusal({ repoKey, event: ev, rule: null, reason: "fork-originated payload refused" });
      return { handled: false, reason: "fork" };
    }

    // Guard: ignore self-caused events (the box's own actor).
    if (self != null && typeof ev.actor === "string" && ev.actor === self) {
      return { handled: false, reason: "self-caused" };
    }

    const rule = match(ev, parsed.rules);
    if (!rule) return { handled: false, reason: "no match" };

    switch (rule.do) {
      case "delegate": {
        const prompt =
          substitutePrompt(rule.prompt ?? DEFAULT_DELEGATE_PROMPT, ev) +
          "\n\n" +
          AUTONOMOUS_JOB_CONTRACT;
        const result = await startDelegate({ prompt, repoKey, event: ev, rule });
        if (!result?.ok) {
          // Cap reached (or another refusal) — recorded, never queued.
          await recordRefusal({
            repoKey,
            event: ev,
            rule,
            reason: result?.error ?? "job refused",
          });
          return { handled: false, reason: "refused", error: result?.error ?? null };
        }
        return { handled: true, verb: rule.do, repoKey, event: ev };
      }
      case "notify": {
        const message = substitutePrompt("Progress on {{title}}: {{url}}", ev);
        await notify({ repoKey, event: ev, rule, message });
        return { handled: true, verb: rule.do, repoKey, event: ev };
      }
      case "inbox": {
        await invalidateInbox({ repoKey, event: ev });
        return { handled: true, verb: rule.do, repoKey, event: ev };
      }
      default:
        return { handled: false, reason: "no match" };
    }
  }

  return { handleEvent, dispatchEvent };
}

// Default loader: read a repo's rules source from the box-side registry.
async function defaultLoadRules(repoKey) {
  // Lazy import avoids a hard cycle with forgeRules.mjs (which imports the
  // shared validator this module also imports) and keeps this module's top-level
  // surface dependency-free for tests that do not pass a custom loader.
  const { getRules } = await import("../forgeRules.mjs");
  return getRules(repoKey);
}
