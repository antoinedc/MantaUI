// Materialized in-memory sync state for the manta box (BET-675).
//
// manta-server previously shelled out to tmux on EVERY `tmux:list` request. A
// transient tmux failure (mid-restart, socket race) was misclassified as "zero
// sessions", so the client got a confident empty list, the sidebar emptied,
// and the ownership sidecar got pruned. This module materializes the session
// list + config in memory with a monotonic sequence cursor, serves snapshots
// instantly from memory, and publishes `sync` deltas on the event bus as
// state changes.
//
// PURE + injected-I/O only: all external effects (listProjects + publish) are
// injected. No tmux / fs imports, no live bus here — the poller in index.mjs
// drives refreshNow().
//
// Cursor model:
//   - `gen`: random 8-hex string, generated once per createSyncState call.
//     Identifies a server process generation. A client that reconnects to a
//     NEW server process sees gen mismatch → full snapshot.
//   - `seq`: integer, starts at 1. Any state change → seq += 1, and the
//     changed field's version is recorded in `versions` (each field holds the
//     seq at which it last changed).
//   - `payloadSince(sinceSeq, sinceGen)` returns only the fields whose version
//     is > sinceSeq, so a client can recover just the deltas it missed.

import { randomBytes } from "node:crypto";

function defaultGenId() {
  return randomBytes(4).toString("hex"); // 8-char hex
}

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listProjects   one tmux listing tick
 * @param {(env: object) => void} deps.publish        pushes `{kind:"sync",…}` envelopes on the bus
 * @param {() => string} [deps.genId]                 injectable gen generator (default: crypto)
 */
export function createSyncState({ listProjects, publish, genId = defaultGenId }) {
  const gen = genId();
  let seq = 1;
  let projects = [];
  let config = null;
  let stale = false;
  let everSucceeded = false;
  const versions = { projects: 0, config: 0, stale: 0 };

  function bump(field, value) {
    seq += 1;
    versions[field] = seq;
    publish({ kind: "sync", gen, seq, changed: { [field]: value } });
  }

  // Dedupe concurrent refreshes: if a refresh is already in flight, await the
  // SAME promise rather than issuing a second listProjects tick.
  let refreshPromise = null;

  async function refreshNow() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const p = await listProjects();
        everSucceeded = true;
        if (JSON.stringify(p) !== JSON.stringify(projects)) {
          projects = p;
          bump("projects", projects);
        }
        if (stale) {
          stale = false;
          bump("stale", false);
        }
      } catch {
        // A fault is recorded as stale but NEVER clobbers the last-known-good
        // projects — the client keeps serving the last good list, flagged.
        if (!stale) {
          stale = true;
          bump("stale", true);
        }
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function applyConfig(cfg) {
    if (JSON.stringify(cfg) !== JSON.stringify(config)) {
      config = cfg;
      bump("config", config);
    }
  }

  function snapshot() {
    return { gen, seq, projects, config, stale };
  }

  function payloadSince(sinceSeq, sinceGen) {
    // Full-snapshot case: no cursor, a different process generation, or an
    // impossible future seq → return everything and let the client rebase.
    if (sinceSeq == null || sinceSeq > seq || sinceGen !== gen) {
      return { gen, seq, changed: { projects, config, stale } };
    }
    const changed = {};
    if (versions.projects > sinceSeq) changed.projects = projects;
    if (versions.config > sinceSeq) changed.config = config;
    if (versions.stale > sinceSeq) changed.stale = stale;
    return { gen, seq, changed };
  }

  function everSucceededFn() {
    return everSucceeded;
  }

  return {
    refreshNow,
    applyConfig,
    snapshot,
    payloadSince,
    everSucceeded: everSucceededFn,
  };
}
