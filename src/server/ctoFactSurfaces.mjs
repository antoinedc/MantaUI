// ctoFactSurfaces.mjs — BET-1409: the REAL §6.7 checkable-verify surfaces and
// the §6.6 trace resolver, as one injectable bundle for createCtoEngine's
// factSurfaceExists / factVerify / factResolveRef seams (which default to
// no-ops, ctoEngine.mjs BET-1389 — nothing got stamped checkable without
// this). Surfaces are OPPORTUNISTIC (§6.7): a fact is only stamped checkable
// when its verification surface actually exists on the box —
//   git   → a git binary AND the fact's project resolving to a git worktree
//           (probe: `git cat-file -e`, which resolves branch names and
//           commit/short-shas alike through the revision machinery)
//   ci    → a gh binary AND a usable repo surface (probe polarity checked
//           against the latest completed run's conclusion; a statement that
//           names a branch scopes the query to that branch — BET-1504 —
//           otherwise the repo-wide latest run is the evidence)
//   issue → a multica binary AND a consented issue tool in the §7 registry
//           ("a consented tool for issue facts" — consent metadata ring)
// Any other surface (e.g. "version") is unimplemented here → surfaceExists
// false → the fact stays an ordinary fact. A probe that cannot run (no cwd,
// CLI error, no runs) is a FAILED check, not a crash — the engine's
// verify-supersede path routes it through the gatekeeper.
//
// The trace resolver (§6.6 gatekeeper spot-check) resolves only what it can
// CONFIDENTLY resolve — opencode message/session ids via the read-only db
// handle and commit shas via git exec; everything else (file paths, issue
// keys, opaque ids) passes with no opinion, because the spot-check must never
// reject an honest proposal it merely fails to understand.

export const COMMIT_SHA_RE = /^(?:[0-9a-f]{7,12}|[0-9a-f]{40})$/i;
// Deliberately NOT 13-39 hex: a bare 32-hex string is a box_id (the token
// identity model), not a commit — tracing it against git would reject honest
// proposals. 7-12 covers the short shas agents copy from `git log --oneline`;
// 40 is the full sha1 form.

export const MESSAGE_REF_RE = /^(?:msg|ses|part)_[A-Za-z0-9]+$/;

const CI_POSITIVE = new Set(["green", "passing", "passed"]);
const CI_NEGATIVE = new Set(["failed", "failing", "broken"]);

// Pure: does the latest completed run's conclusion confirm the statement's
// CI-status probe? Positive probes ("CI is green") match success only;
// negative probes ("CI is broken") match ANY completed non-success conclusion
// (failure, cancelled, timed_out, startup_failure) — a run that did not
// succeed confirms "broken".
export function ciConclusionMatches(probe, conclusion) {
  const p = String(probe ?? "").toLowerCase();
  const c = String(conclusion ?? "").toLowerCase();
  if (!p || !c) return false;
  if (CI_POSITIVE.has(p)) return c === "success";
  if (CI_NEGATIVE.has(p)) return c !== "success";
  return false;
}

export function createFactSurfaces(deps = {}) {
  const {
    // async (project|null) → ordered candidate cwds. A project (tmux session
    // name — the facts store's project key) narrows to that project's
    // worktree(s); null (the trace resolver's commit check) yields every
    // known project cwd, first match wins.
    cwdsFor = async () => [],
    // async (cwd, args) → stdout; THROWS on non-zero exit.
    runGit = async () => {
      throw new Error("runGit not wired");
    },
    // async (name) → boolean — binary presence on PATH.
    hasBinary = async () => false,
    // async (cwd) → boolean — is this directory a usable verification
    // surface (a git worktree; the wiring adds the origin-remote requirement
    // it needs for CI). Absent → every cwd is treated as ready.
    gitRepoReady = null,
    // async (key) → { found: boolean, open: boolean } | null (null =
    // lookup unavailable). `open` is authoritative: done/cancelled → false.
    issueLookup = async () => null,
    // async (cwd) → latest COMPLETED workflow run's conclusion string, or
    // null when none/unknown (gh error, no runs yet).
    ciLatestConclusion = async () => null,
    // async (id) → boolean | null (null = db unavailable → no opinion).
    messageExists = async () => null,
    // async () → boolean — the §7 registry reports an issue tool whose
    // metadata consent ring is "yes".
    issueToolConsented = async () => false,
  } = deps;

  async function readyCwds(project) {
    const out = [];
    for (const cwd of await cwdsFor(project ?? null)) {
      if (typeof cwd !== "string" || !cwd) continue;
      if (!gitRepoReady || (await gitRepoReady(cwd).catch(() => false))) out.push(cwd);
    }
    return out;
  }

  // §6.7 surface guard — called by maybeStampCheckable with
  // { project } ctx (the facts store key). No surface → no stamp.
  async function surfaceExists(surface, ctx = {}) {
    try {
      if (surface === "git") {
        if (!(await hasBinary("git"))) return false;
        return (await readyCwds(ctx?.project)).length > 0;
      }
      if (surface === "ci") {
        if (!(await hasBinary("gh"))) return false;
        return (await readyCwds(ctx?.project)).length > 0;
      }
      if (surface === "issue") {
        if (!(await hasBinary("multica"))) return false;
        return (await issueToolConsented()) === true;
      }
      return false; // "version" and anything unknown → ordinary fact
    } catch {
      return false;
    }
  }

  // §6.7 verify probe — called by verifyDue as
  // { surface, probe, branch, project }. Returns { ok, result }.
  // branch (BET-1504) is ci-only scope: null → repo-wide latest run.
  async function verify({ surface, probe, branch = null, project } = {}) {
    if (surface === "git") {
      const cwds = await readyCwds(project ?? null).catch(() => []);
      if (cwds.length === 0) return { ok: false, result: "no surface" };
      try {
        await runGit(cwds[0], ["cat-file", "-e", String(probe ?? "")]);
        return { ok: true, result: "exists" };
      } catch {
        return { ok: false, result: "missing" };
      }
    }
    if (surface === "ci") {
      const cwds = await readyCwds(project ?? null).catch(() => []);
      if (cwds.length === 0) return { ok: false, result: "no surface" };
      // BET-1504: a statement that names a branch ("CI on branch F is green")
      // must be confirmed by THAT branch's latest run — the repo-wide latest
      // run never looked at F and cannot confirm (or refute) its state.
      const conclusion = await ciLatestConclusion(cwds[0], branch ?? null).catch(() => null);
      if (!conclusion) return { ok: false, result: "unavailable" };
      return { ok: ciConclusionMatches(probe, conclusion), result: String(conclusion) };
    }
    if (surface === "issue") {
      const r = await issueLookup(String(probe ?? "")).catch(() => null);
      if (!r) return { ok: false, result: "unavailable" };
      if (!r.found) return { ok: false, result: "not-found" };
      return { ok: r.open === true, result: r.open ? "open" : "closed" };
    }
    return { ok: false, result: "no surface" };
  }

  // §6.6 trace spot-check — gatekeeperPrecheck calls resolveRef(ref) === true
  // per ref; ANY throw counts as unresolved, so this never throws. Only
  // confidently-recognizable shapes are traced; everything else passes with
  // no opinion (never punish a proposal for a ref we can't interpret).
  async function resolveRef(ref) {
    const s = String(ref ?? "").trim();
    if (!s) return false;
    try {
      if (MESSAGE_REF_RE.test(s)) {
        const exists = await messageExists(s);
        return exists !== false; // null (no db) → no opinion → pass
      }
      if (COMMIT_SHA_RE.test(s)) {
        // Try every ready git surface — facts cite commits from whatever repo
        // the work was about, and the box hosts several checkouts. No ready
        // cwd at all → no opinion.
        const cwds = await readyCwds(null).catch(() => []);
        if (cwds.length === 0) return true;
        for (const cwd of cwds) {
          try {
            await runGit(cwd, ["cat-file", "-e", s]);
            return true;
          } catch {
            /* not in this repo — try the next candidate */
          }
        }
        return false;
      }
      return true; // file paths, issue keys, opaque ids — no opinion
    } catch {
      return true;
    }
  }

  return { surfaceExists, verify, resolveRef };
}
