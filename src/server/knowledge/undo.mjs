// undo.mjs — undo of a curator change (spec §8). Implements the engine's `deps.undo(change, ctx)`.
//
//   store change      `git revert` of its commit under the store lock. A conflict with a later commit fails
//                     with an error naming it; nothing is half-applied (the store reverts to a clean tree).
//   managed block     re-rendered after the revert: project rules → `repoWriter.applyRules` (when the project
//                     writes outward); preferences → the global block, applied IMMEDIATELY (undo is a user
//                     action; only the curator's own writes wait for the 04:00 batch).
//   repository change `repoWriter.revert(change)` (direct: revert commit; unmerged PR: removed from the branch;
//                     merged PR: a revert PR), then the stored rules that produced it are reverted too.
//   skill             `skills.remove(skillSlug)`.
//   always            a tombstone (`tombstones.json`), so the curator never re-proposes it.
//   user edit         a Recent-changes entry for a commit of the user's own (hand) edits: `git revert`.
//   downgrade         refused while the project that stopped sharing is still not sharing (the cleanup would
//                     just be undone into a leak).
// Every path returns `{ok:true, warning?}` or `{ok:false, reason, conflictWith?}`; it never throws. A `warning`
// means the undo happened but something around it didn't (the global file, the tombstone).

import { PREFERENCES_PATH } from "./globalBlock.mjs";
import { feedsShared } from "./sharing.mjs";

const REVERT_REASONS = {
  "nothing-to-revert": "A later edit already took this change out.",
  "unknown-commit": "That change's commit is no longer in the knowledge store.",
};

/** kc: store, changes, tombstones, rules, globalBlock, curator, deps {repoWriter, skills}, state, log. */
export function createUndo(kc) {
  const { store, changes, tombstones, rules, globalBlock, curator, deps, state, settings, log } = kc;
  const joinWarnings = (list) => (list.length ? { warning: list.join(" ") } : {});

  function revertFailure(r) {
    if (r.reason === "conflict") {
      const later = r.conflictWith?.subject ? ` ("${String(r.conflictWith.subject).slice(0, 80)}")` : "";
      return { ok: false, reason: `A later change${later} touches the same text. Undo that one first.`, ...(r.conflictWith ? { conflictWith: r.conflictWith } : {}) };
    }
    return { ok: false, reason: REVERT_REASONS[r.reason] ?? `The change couldn't be reverted${r.message ? `: ${r.message}` : "."}` };
  }

  async function afterRuleUndone(change, data, { skipRepo }) {
    const slug = change.slug;
    if (!slug) return;
    if (data.decisionType === "rule.add") rules.untrack(slug, data.text);
    else if (data.decisionType === "rule.change") {
      const cur = rules.trackedFor(slug, data.text);
      rules.untrack(slug, data.text);
      if (data.replaces) rules.track({ slug, text: data.replaces, reason: "", clusterId: cur?.cluster_id ?? null, rewrites: cur?.rewrites ?? 0 });
    } else if (data.decisionType === "rule.remove") rules.track({ slug, text: data.text, reason: "Restored by undo." });
    if (!skipRepo) {
      try {
        await curator.pushRules(slug, { reason: "an undo" });
      } catch (e) {
        log("[knowledge] re-rendering the repository block after undo failed:", e?.message ?? e);
      }
    }
  }

  /** Revert one stored change (+ re-render + tombstone). */
  async function undoStore(change, { tombstone = true, skipRepo = false } = {}) {
    const data = change.data ?? {};
    if (!change.commitSha) return { ok: false, reason: "That change has no recorded commit to revert." };
    const warnings = [];
    const r = await store.withLock(async (tx) => {
      const out = await tx.revert(change.commitSha, { trailers: { "Manta-Undo": change.id } });
      if (!out.ok) return out;
      if (tombstone && !data.noTombstone && data.tombstoneKind && data.claim !== undefined) {
        try {
          await tombstones.add(tx, { kind: data.tombstoneKind, target: data.tombstoneTarget ?? "", claim: data.claim, clusterId: data.clusterId ?? null, decisionId: change.decisionId, summary: change.summary });
        } catch (e) {
          log("[knowledge] writing the tombstone failed:", e?.message ?? e);
          warnings.push("It was undone, but Manta couldn't remember that, so it may propose the same thing again.");
        }
      }
      return out;
    });
    if (!r.ok) return revertFailure(r);
    if (data.kind === "rule") await afterRuleUndone(change, data, { skipRepo });
    if (data.kind === "preference") {
      if (data.text) rules.dropBullet(data.path, data.text);
      if (data.path === PREFERENCES_PATH) {
        const g = await globalBlock.apply({ reason: "an undo" });
        if (g.ok === false && !g.off) warnings.push(`Undone in the store, but the global file couldn't be updated (${g.error ?? "unknown error"}); it will be retried.`);
      }
    }
    return { ok: true, ...joinWarnings(warnings) };
  }

  async function undoOutward(change) {
    if (!deps.repoWriter) return { ok: false, reason: "Repository writes aren't available on this box." };
    const out = change.data?.outward;
    if (!out) return { ok: false, reason: "There's no record of what was written to the repository." };
    let r;
    try {
      r = await deps.repoWriter.revert({ ...out, changeId: change.id });
    } catch (e) {
      r = { ok: false, reason: `The repository change couldn't be reverted: ${String(e?.message ?? e).slice(0, 160)}` };
    }
    if (!r?.ok) return { ok: false, reason: String(r?.reason ?? "The repository change couldn't be reverted."), ...(r?.conflictWith ? { conflictWith: r.conflictWith } : {}) };
    const left = [];
    const warnings = [];
    for (const id of change.data?.linkedChangeIds ?? []) {
      const linked = changes.get(id);
      if (!linked || linked.undoneAt || !linked.undoable) continue;
      const s = await undoStore(linked, { skipRepo: true });
      if (s.ok) {
        changes.markUndone(id);
        if (s.warning) warnings.push(s.warning);
      } else left.push(s.reason);
    }
    if (out.slug) {
      state.kvDelete(`pr.open:${out.slug}`);
      rules.setJson("prChanges", out.slug, []);
      // a rule that stays in the store but is gone from the repository must keep reaching sessions
      if (left.length) rules.setViaBriefing(out.slug, true);
    }
    if (left.length) changes.add({ kind: "notice", summary: "Repository change undone; some stored rules were kept", reason: `${left.join(" ").slice(0, 380)} They are delivered through the briefing.`, area: "repo-block", slug: change.slug ?? null });
    return { ok: true, ...joinWarnings(warnings) };
  }

  async function undoSkill(change) {
    const data = change.data ?? {};
    if (!deps.skills) return { ok: false, reason: "Skills aren't available on this box." };
    let r;
    try {
      r = await deps.skills.remove(data.skillSlug);
    } catch (e) {
      r = { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
    }
    if (!r?.ok) return { ok: false, reason: String(r?.reason ?? "The skill couldn't be removed.") };
    try {
      await store.withLock((tx) => tombstones.add(tx, { kind: "skill", target: `skill:${data.skillSlug}`, claim: data.skillSlug, sources: data.sessions ?? data.sources ?? null, decisionId: change.decisionId, summary: change.summary }));
    } catch (e) {
      log("[knowledge] writing the skill tombstone failed:", e?.message ?? e);
      return { ok: true, warning: "The skill was removed, but Manta couldn't remember that, so it may learn it again." };
    }
    return { ok: true };
  }

  /** A downgrade cleanup can't be undone while a project it concerns still doesn't share. */
  async function downgradeBlocked(change) {
    for (const slug of change.data?.slugs ?? []) {
      let eff;
      try {
        eff = await settings.effective(slug);
      } catch {
        return `Couldn't check whether ${slug} shares its knowledge, so the cleanup was left as it is.`;
      }
      if (!feedsShared(eff.sharing)) {
        const p = await kc.registry?.get(slug);
        return `${p?.displayName ?? slug} still doesn't share its knowledge, so this can't be restored. Turn sharing back on first.`;
      }
    }
    return null;
  }

  /** The engine hook: `undo(change, ctx)`. Never throws. */
  async function undoChange(change, opts = {}) {
    try {
      if (change.kind === "outward") return await undoOutward(change);
      if (change.data?.skillSlug) return await undoSkill(change);
      const userEdit = change.kind === "notice" && change.data?.kind === "user-edit";
      if (change.kind !== "applied" && !userEdit) return { ok: false, reason: "That change can't be undone." };
      if (change.data?.kind === "downgrade") {
        const blocked = await downgradeBlocked(change);
        if (blocked) return { ok: false, reason: blocked };
      }
      return await undoStore(change, opts);
    } catch (e) {
      log("[knowledge] undo failed:", e?.message ?? e);
      return { ok: false, reason: `Undo failed: ${String(e?.message ?? e).slice(0, 160)}` };
    }
  }

  /**
   * A closed (unmerged) pull request counts as an undo of its decisions (spec §4.1): the stored rules that
   * only travelled in that PR are reverted, with tombstones. The repository side is already gone.
   */
  async function undoClosedPr(slug) {
    const ids = rules.getJson("prChanges", slug, []);
    let n = 0;
    let failed = 0;
    for (const id of ids) {
      const c = changes.get(id);
      if (!c || c.undoneAt || !c.undoable) continue;
      const r = await undoStore(c, { skipRepo: true });
      if (r.ok) {
        changes.markUndone(id);
        n++;
      } else {
        failed++;
        changes.setError(id, r.reason);
      }
    }
    rules.setJson("prChanges", slug, []);
    state.kvDelete(`pr.open:${slug}`);
    // a rule that couldn't be taken back stays in the store but is not in the repository: keep delivering it
    rules.setViaBriefing(slug, failed > 0);
    if (ids.length) changes.add({ kind: "undo", summary: `A pull request was closed; ${n} rule change${n === 1 ? "" : "s"} undone`, reason: "Closing the pull request without merging counts as undoing its changes.", area: "repo-block", slug });
    return n;
  }

  return { undo: (change) => undoChange(change), undoChange, undoClosedPr };
}
