// engine.mjs — the knowledge engine factory (spec §6.3, §11.1): constructs and wires
// every foundation module, owns the lifecycle and the pollers, and exposes the
// operations the HTTP routes and RPC channels call.
//
// INDEPENDENT of the CTO engine (`ctoEnabled`): its own settings, budget, pollers.
// Without Node 24 (`node:sqlite`) the subsystem is off and says why (`status()`).
//
// The layers built on top of this foundation (curator, capture, correction detector,
// skills, undo, repo writes) get everything they need from the returned object:
//   engine.store      git store: withLock(tx => tx.commit/revert/…), onCommit, listPages…
//   engine.state      state.sqlite (state.migrate(id, ddl) for their own tables)
//   engine.registry   project registry (list/get/identify)
//   engine.sessionMap session → project map (get/pin/markCaptured/directoriesFor)
//   engine.queue      note queue (enqueue/list/consume/stats/slugs)
//   engine.settings   settings (get/effective/effectiveRepoRules/outward/set)
//   engine.budget     spend ledger (canSpend/record/canBatch/recordBatch)
//   engine.changesLog Recent-changes log (add/list/get/markUndone/setError); engine.changes() is the RPC list
//   engine.scanner    secret scanner (scan/redact)
//   engine.briefings  briefing precompute/serving
//   engine.deps       the injected deps (runner, prompt origins, forge, …)
// NEVER call `registry.identify()` while holding the store lock: it commits
// `projects.json` through the same lock.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startPoller } from "../startPoller.mjs";
import { estimateTokens as defaultEstimateTokens } from "../ctoSessions.mjs";
import { KnowledgeError, isKnowledgeError } from "./errors.mjs";
import { createGitRunner } from "./gitRunner.mjs";
import { createIdentityResolver, createProjectRegistry, emptyRegistry } from "./identity.mjs";
import { openState } from "./state.mjs";
import { createSessionMap } from "./sessionMap.mjs";
import { createKnowledgeStore } from "./store.mjs";
import { createSettings, effectiveFor } from "./settings.mjs";
import { createSecretScanner } from "./secretScan.mjs";
import { createQueue, NoteRejected, validateNote } from "./queue.mjs";
import { createBriefings } from "./briefing.mjs";
import { createPageIndex, createSearch } from "./search.mjs";
import { createBudget } from "./budget.mjs";
import { readBackgroundWork } from "../backgroundBudget.mjs";
import { createChangeLog } from "./changes.mjs";
import { createCuratorLayer } from "./curator.mjs";
import { createRulesStore } from "./rules.mjs";
import { listSessionsPage as defaultListSessionsPage } from "./backfillSource.mjs";
import { statePath } from "../../shared/paths.mjs";

const ENABLED_MEMO_MS = 5000;
const PAUSE_MEMO_MS = 60_000;
const DAY_MS = 24 * 3600 * 1000;
const OBSERVE_TYPES = new Set(["session.created", "session.execution.started", "session.status"]);

const disabled = (reason = "Shared knowledge is off.") => new KnowledgeError("disabled", reason, { status: 503 });

/**
 * deps (all optional except `config`):
 *   config {get(), update(patch)}            local.configGet / configUpdate
 *   dir, git, importSqlite, now, log
 *   getSession(id) → session|null            {directory, parentID, agent, metadata, projectID}
 *   isCtoSession(id) → boolean               ctoConversation.isConversationSession
 *   listSessionsPage({afterId, limit})       history backfill source (default: opencode's session_v2)
 *   searchTranscripts({query, directories, anyTerms, limit}) → {hits, truncated}   [INTEGRATION: ctoSearchIndex]
 *   isManagedSession(sessionID) → boolean   a session that is the child of a Manta-owned background job (never inherits its parent's project)
 *   readMessages({sessionID, messageIDs, radius}) → [{id, role, text, at}] | null
 *   isUserAuthoredRef(ref, {sessionID}) → boolean                                   [INTEGRATION: prompt origins]
 *   getRepoAccess({kind, host, owner, repo}) → {canPush, isFork, defaultBranch}     [INTEGRATION: forge]
 *   hasForgeLogin(kind) → boolean                                                   [INTEGRATION: forge]
 *   backgroundBudget                         the shared background-work budget (src/server/backgroundBudget.mjs): every model call
 *                                            is gated and booked through it; absent → knowledge's model work is refused (fail closed)
 *   getPrices() / bandOf(providerID, modelID)  ledger pricing (optimizer prices, router band)
 *   projectRules(slug, {repoRules}) → string[] briefing part 1 override
 *   undo(change, ctx) → {ok:true} | {ok:false, reason, conflictWith?}                [curator layer]
 *   onSettingsChanged({prev, next})          downgrade cleanup hook                  [curator layer]
 *   secretValues() / loadLint()              secret scanner overrides (tests)
 *   fireNotify({message, title, tag})        push.fireNotify
 *   estimateTokens(text)                     default: ctoSessions.estimateTokens
 *   runEphemeral / resolveModelForClass      the CTO task-class runner, carried for the curator [INTEGRATION: runner]
 *
 * The curator layer (curator.mjs, tidy.mjs, undo.mjs, globalBlock.mjs) is wired here. Each part is OFF when
 * its dep is absent and `status().parts` says so — never a crash:
 *   runEphemeral({taskClass, operation, context, directory, deps:{reportCost, validate}}) → {text}|{ok:false, code}
 *                                            the curator's model calls (absent → no curation)
 *   isUserAuthoredRef + readMessages         user-authored evidence (absent → no rules/preferences)
 *   readShellCommands(sessionID) → string[]|null   shell tool-call inputs of a session (absent → commands on pages refused)
 *   corrections {runWeekly, recurrenceSince}       the correction detector (A2)
 *   repoWriter {applyRules, sync, revert}          outward repository writes (A3)
 *   skills {detect, retire, remove, sourceProjects[, list]}   learned skills (A3)
 *   globalAgentsPath                         the global opencode AGENTS.md (absent → no global block)
 *   refResolves(ref) → boolean|null          tidy re-verification override (default: messages, pages and files)
 *   curatorMs                                curator poll interval (default 60 s)
 *   createParts(foundation) → parts          wiring.mjs `createKnowledgeParts` bound to its collaborators: capture,
 *                                            corrections, repoWriter, skills + trial, blackboard import, weekly notice
 */
export function createKnowledgeEngine(deps = {}) {
  const { config } = deps;
  if (!config || typeof config.get !== "function" || typeof config.update !== "function") throw new Error("createKnowledgeEngine: config {get, update} is required");
  const dir = deps.dir ?? statePath("knowledge");
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.warn;
  const estimateTokens = deps.estimateTokens ?? defaultEstimateTokens;
  const git = deps.git ?? createGitRunner({ defaultCwd: dir });

  let c = null; // the wired context, set by init()
  let initError = null;
  let readyP = null;
  let poller = null;
  let curatorPoller = null;
  let curatorTick = null;
  let enabledMemo = { at: 0, value: null };
  let derivedRunning = null;
  let derivedAgain = false;

  const registryProxy = {
    list: async () => (c ? c.registry.list() : []),
    get: async (slug) => (c ? c.registry.get(slug) : null),
  };
  const settings = createSettings({ config, registry: registryProxy, getRepoAccess: deps.getRepoAccess, hasForgeLogin: deps.hasForgeLogin, now });

  async function enabledState() {
    const t = now();
    if (enabledMemo.value && t - enabledMemo.at < ENABLED_MEMO_MS) return enabledMemo.value;
    const s = await settings.get();
    enabledMemo = { at: t, value: { enabled: s.enabled, observeOnly: s.observeOnly } };
    return enabledMemo.value;
  }
  const invalidateEnabled = () => {
    enabledMemo = { at: 0, value: null };
  };

  // ---- derived data: page index + briefings, refreshed after every store commit -----------
  function scheduleDerived() {
    if (!c) return Promise.resolve();
    if (derivedRunning) {
      derivedAgain = true;
      return derivedRunning;
    }
    derivedRunning = (async () => {
      do {
        derivedAgain = false;
        try {
          await c.pageIndex.rebuild();
          await c.briefings.precomputeAll();
        } catch (e) {
          log("[knowledge] derived refresh failed:", e?.message ?? e);
        }
      } while (derivedAgain);
    })().finally(() => {
      derivedRunning = null;
    });
    return derivedRunning;
  }

  async function init() {
    let state;
    try {
      state = await openState({ path: join(dir, "state.sqlite"), importSqlite: deps.importSqlite });
    } catch (e) {
      initError = e;
      return;
    }
    try {
      const scanner = createSecretScanner({ loadLint: deps.loadLint, secretValues: deps.secretValues });
      const store = createKnowledgeStore({ dir, git, scan: (t) => scanner.scan(t), now, log });
      await store.init();
      const resolver = createIdentityResolver({ git, now });
      const registry = createProjectRegistry({
        resolver,
        now,
        load: async () => {
          const raw = await store.read("projects.json");
          try {
            return raw ? JSON.parse(raw) : emptyRegistry();
          } catch {
            return emptyRegistry();
          }
        },
        save: async (doc, message) => {
          await store.commit({ path: "projects.json", content: `${JSON.stringify(doc, null, 2)}\n`, message });
        },
      });
      const changes = createChangeLog({ state, now });
      const sessionMap = createSessionMap({ state, registry, getSession: deps.getSession, isCtoSession: deps.isCtoSession, isManagedSession: deps.isManagedSession, listSessionsPage: deps.listSessionsPage ?? defaultListSessionsPage, now, log });
      const queue = createQueue({
        state,
        scanner,
        now,
        root: join(dir, ".queue"),
        isUserAuthoredRef: deps.isUserAuthoredRef,
        onDrop: (slug, n) => changes.add({ kind: "dropped", summary: `Dropped ${n} queued note${n === 1 ? "" : "s"}`, reason: "The note queue for this project was full (500).", area: "project", slug }),
      });
      const budget = createBudget({
        state,
        backgroundBudget: deps.backgroundBudget,
        // The model a class will run on, so a gate asks the shared budget about the right provider (plan vs API key).
        resolveModel: deps.resolveModelForClass ? (taskClass) => deps.resolveModelForClass(taskClass, { configGet: () => config.get() }) : null,
        getPrices: deps.getPrices,
        bandOf: deps.bandOf,
        now,
      });
      const rules = createRulesStore({ store, state, now });
      const briefings = createBriefings({
        state,
        store,
        registry,
        sessionMap,
        settings,
        estimateTokens,
        getSession: deps.getSession,
        isCtoSession: deps.isCtoSession,
        isActive: async () => {
          const e = await enabledState();
          return e.enabled && !e.observeOnly;
        },
        projectRules: deps.projectRules ?? ((slug, o) => rules.projectRulesForBriefing(slug, o)),
        heldRules: (slug) => rules.heldBack(slug),
        dir: join(dir, ".briefings"),
        now,
      });
      const pageIndex = createPageIndex({ state, store, now });
      const search = createSearch({ state, store, registry, sessionMap, settings, searchTranscripts: deps.searchTranscripts, readMessages: deps.readMessages, scanner });
      const briefingsDir = join(dir, ".briefings");
      // The parts on top of the foundation (capture, corrections, repository writes, skills, blackboard import,
      // the weekly notice): built by the composition root's factory from the handles that exist only now.
      const parts =
        deps.createParts?.({ state, store, registry, sessionMap, queue, budget, changes, scanner, settings, git, dir, now, log, isKnowledgeRunActive: () => c?.layer?.curator.isBusy() === true }) ?? null;
      const layerDeps = {
        ...deps,
        ...(parts?.layerDeps ?? {}),
        sessionBriefingText:
          deps.sessionBriefingText ??
          (async (sid) => {
            if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(sid)) return "";
            try {
              return await readFile(join(briefingsDir, `${sid}.txt`), "utf8");
            } catch {
              return "";
            }
          }),
      };
      const layer = createCuratorLayer({ store, state, queue, settings, budget, changes, registry, sessionMap, briefings, rules, scanner, git, dir, deps: layerDeps, now, log, estimateTokens });
      c = { state, scanner, store, registry, resolver, changes, sessionMap, queue, budget, briefings, pageIndex, search, layer, parts };
      store.onCommit(() => void scheduleDerived());
      await scheduleDerived();
      await maybeNotifyUpgrade();
    } catch (e) {
      initError = e;
      c = null;
      state.close();
      log("[knowledge] failed to start:", e?.message ?? e);
    }
  }

  async function maybeNotifyUpgrade() {
    if (!c || !deps.fireNotify || c.state.kvGet("upgrade.notified") === "1") return;
    const s = await settings.get();
    if (!s.enabled || s.observeOnly) return;
    c.state.kvSet("upgrade.notified", "1");
    try {
      const cap = readBackgroundWork((await config.get())?.backgroundWork).dailyCapUsd;
      await deps.fireNotify({
        title: "Shared knowledge is on",
        message: `Manta now keeps short notes from your sessions and shares what it learns between them. It works in the background on spare plan quota, and spends up to $${cap.toFixed(2)} a day on API keys, on models Manta picks. Open Settings → Knowledge to review it or turn it off, or Settings → Models to change the limits.`,
        tag: "knowledge-upgrade",
      });
    } catch (e) {
      log("[knowledge] upgrade notification failed:", e?.message ?? e);
    }
  }

  const ready = () => (readyP ??= init());

  let lastPrune = 0;
  async function maintenance() {
    if (!c) return;
    const e = await enabledState();
    if (!e.enabled) return;
    try {
      await c.sessionMap.backfillStep({ budgetMs: 2000 });
    } catch (err) {
      if (err?.code !== "no_db") log("[knowledge] backfill step failed:", err?.message ?? err);
    }
    await c.briefings.sweep();
    await c.parts?.maintain();
    if (now() - lastPrune > DAY_MS) {
      lastPrune = now();
      c.budget.prune();
      c.changes.prune();
    }
  }

  async function start() {
    await ready();
    if (c && !poller) poller = startPoller(maintenance, { intervalMs: deps.maintenanceMs ?? 60_000, label: "knowledge", now });
    if (c && !curatorPoller) {
      curatorPoller = startPoller(
        async () => {
          const layer = c?.layer;
          if (!layer) return;
          curatorTick = layer.tick();
          try {
            await curatorTick;
          } finally {
            curatorTick = null;
          }
        },
        { intervalMs: deps.curatorMs ?? 60_000, label: "knowledge-curator", now, immediate: deps.curatorImmediate ?? false },
      );
    }
    return status();
  }
  async function stop() {
    poller?.stop();
    poller = null;
    curatorPoller?.stop();
    curatorPoller = null;
    if (curatorTick) await Promise.race([curatorTick.catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
    if (derivedRunning) await derivedRunning.catch(() => {});
    if (c) {
      c.state.close();
    }
    c = null;
    readyP = null;
  }

  // ---- guards ---------------------------------------------------------------------
  async function requireOn({ allowObserveOnly = false } = {}) {
    await ready();
    if (!c) throw disabled(initError?.code === "unsupported" ? "Shared knowledge needs the Node 24 runtime and is off on this box." : "Shared knowledge isn't available on this box.");
    const e = await enabledState();
    if (!e.enabled) throw disabled();
    if (e.observeOnly && !allowObserveOnly) throw disabled();
    return c;
  }

  // ---- events ---------------------------------------------------------------------
  /** Feed raw V2 events and/or lifecycle events from the opencode pump. Never throws. */
  async function observeRaw(ev) {
    try {
      if (!c) return;
      const type = ev?.type;
      const wanted = OBSERVE_TYPES.has(type) || (typeof type === "string" && type.startsWith("session.") && c.parts);
      if (!wanted) return;
      if (!(await enabledState()).enabled) return;
      if (OBSERVE_TYPES.has(type)) await c.sessionMap.observe(ev);
      // after the session map has seen it: capture's activity tracking and the trial's completion
      c.parts?.observeRaw(ev);
    } catch (e) {
      log("[knowledge] observe failed:", e?.message ?? e);
    }
  }

  /**
   * Pin a session to its project from an explicit directory — the hook for the prompt chokepoint
   * (first user message) when the caller already knows the directory. Same rules as the event
   * path (excluded sessions are never mapped; a move re-pins only while nothing is captured).
   */
  async function pinSession({ sessionID, directory, force = false } = {}) {
    if (!c || !(await enabledState()).enabled || typeof sessionID !== "string" || !sessionID) return null;
    return c.sessionMap.pin({ sessionID, directory, source: "prompt", force: force === true });
  }

  // ---- AI-facing operations (HTTP routes) -----------------------------------------
  async function enqueueNote({ sessionID, kind, text, refs } = {}) {
    const ctx = await requireOn({ allowObserveOnly: true });
    let clean;
    try {
      clean = validateNote({ kind, text, refs }, { origin: "tool" });
    } catch (e) {
      if (e instanceof NoteRejected) throw new KnowledgeError("invalid-note", e.reason, { status: 400 });
      throw e;
    }
    if (typeof sessionID !== "string" || sessionID === "") throw new KnowledgeError("invalid-note", "sessionID is required.", { status: 400 });
    let mapping = ctx.sessionMap.get(sessionID);
    if (!mapping) mapping = await ctx.sessionMap.pin({ sessionID, source: "note" });
    if (!mapping) return { accepted: false, reason: "This session isn't part of a known project, so the note wasn't kept." };
    const r = await ctx.queue.enqueue({ slug: mapping.slug, sessionID, origin: "tool", ...clean });
    return r.accepted ? { accepted: true, id: r.id } : { accepted: false, reason: r.reason };
  }

  const search = async (args) => (await requireOn()).search.search(args);
  const readPage = async (args) => (await requireOn()).search.page(args);
  const briefing = async (args) => {
    await ready();
    if (!c) return { text: "", token: null };
    return c.briefings.request(args);
  };
  const briefingAck = async (args) => {
    await ready();
    if (!c) throw new KnowledgeError("stale-token", "That briefing token is no longer current.", { status: 409 });
    return c.briefings.ack(args);
  };
  const briefingReset = async (args) => {
    await ready();
    return c ? c.briefings.reset(args) : { ok: true };
  };

  // ---- desktop operations (RPC) ---------------------------------------------------
  // Is continuous knowledge work (capture, curation) paused by the shared budget right now? `{reason, resumesAt}` or null.
  // Asked of `check` (the same answer a real call gets), at most once a minute: every `check` refusal lands in the budget's
  // evidence log, which a card polling every 30 s must not inflate.
  let pauseMemo = { at: -Infinity, value: null };
  async function currentPause() {
    const t = now();
    if (t - pauseMemo.at < PAUSE_MEMO_MS) return pauseMemo.value;
    let value = null;
    if (c) {
      const d = await c.budget.canSpend({ workType: "knowledge-capture" });
      if (!d.ok) value = { reason: d.reason ?? "unavailable", resumesAt: d.resumesAt ?? null };
    }
    pauseMemo = { at: t, value };
    return value;
  }

  async function status() {
    await ready();
    const s = await settings.get();
    if (!c) {
      const unsupported = initError?.code === "unsupported";
      return {
        state: unsupported ? "unsupported" : "error",
        enabled: s.enabled,
        reason: unsupported ? "Shared knowledge needs the Node 24 runtime (node:sqlite), so it is off on this box." : `Shared knowledge couldn't start: ${String(initError?.message ?? "unknown error").slice(0, 200)}`,
      };
    }
    // Spend is the shared budget's pay-per-token figure (list-price dollars on a plan are not spend), the cap its one daily
    // cap; `capReached` now means "background work is paused right now", whatever the reason (a plan's share, a busy window…).
    const spent = deps.backgroundBudget?.usdToday ? deps.backgroundBudget.usdToday({ mode: "payg" }) : 0;
    const cap = readBackgroundWork((await config.get())?.backgroundWork).dailyCapUsd;
    const budgetPaused = await currentPause();
    const queued = {};
    for (const slug of await c.queue.slugs()) {
      const n = await c.queue.count(slug);
      if (n > 0) queued[slug] = n;
    }
    const wk = c.briefings.weekStats();
    return {
      state: s.enabled ? "on" : "off",
      enabled: s.enabled,
      ...(s.observeOnly ? { observeOnly: true } : {}),
      spentUsd: spent,
      capUsd: cap,
      capReached: budgetPaused !== null,
      budgetPaused,
      queued,
      briefings: { startedThisWeek: wk.served, missedThisWeek: wk.missed },
      backfillDone: c.sessionMap.backfillDone(),
      parts: { ...c.layer.capabilities(), ...(c.parts?.capabilities() ?? {}) },
      curatorBusy: c.layer.curator.isBusy(),
      lastTidy: Number(c.state.kvGet("tidy.lastRun") ?? 0) || null,
    };
  }

  async function settingsGet() {
    await ready();
    return { ...(await settings.view()), status: await status() };
  }

  async function settingsSet(patch) {
    await ready();
    const prev = await settings.get();
    const next = await settings.set(patch);
    invalidateEnabled();
    pauseMemo.at = -Infinity; // a changed cap changes the answer: the status read just below must not use a stale one
    if (c) {
      if (!prev.enabled && next.enabled) c.state.kvDelete("backfill.done");
      void c.briefings.precomputeAll().catch((e) => log("[knowledge] briefing refresh failed:", e?.message ?? e));
    }
    try {
      await c?.layer.onSettingsChanged({ prev, next });
      await deps.onSettingsChanged?.({ prev, next });
    } catch (e) {
      log("[knowledge] onSettingsChanged failed:", e?.message ?? e);
    }
    return settingsGet();
  }

  async function changesList(args = {}) {
    await ready();
    if (!c) return { items: [], nextCursor: null };
    return c.changes.list({ cursor: args?.cursor, limit: args?.limit });
  }

  const undoing = new Set();
  /** `knowledge:undo {id}` → `{ok:true}` | `{ok:false, reason, conflictWith?}`; every outcome is recorded on the change. */
  async function undo(args = {}) {
    await ready();
    if (!c) return { ok: false, reason: "Shared knowledge is off on this box." };
    const change = typeof args?.id === "string" ? c.changes.get(args.id) : null;
    if (!change) return { ok: false, reason: "That change no longer exists." };
    if (change.undoneAt) return { ok: false, reason: "That change was already undone." };
    if (!change.undoable) return { ok: false, reason: "That change can't be undone." };
    // two presses on the same change: the second waits for nothing and records nothing
    if (undoing.has(change.id)) return { ok: false, reason: "That change is already being undone." };
    undoing.add(change.id);
    const undoImpl = deps.undo ?? c.layer.undo;
    let res;
    try {
      try {
        res = await undoImpl(change, { store: c.store, changes: c.changes, registry: c.registry });
      } catch (e) {
        res = { ok: false, reason: isKnowledgeError(e) ? e.message : `Undo failed: ${String(e?.message ?? e).slice(0, 200)}` };
      }
    } finally {
      undoing.delete(change.id);
    }
    if (res?.ok) {
      c.changes.markUndone(change.id);
      return { ok: true, ...(res.warning ? { warning: String(res.warning) } : {}) };
    }
    // it was undone by someone else while this one ran (e.g. a closed pull request): not an error to record
    if (c.changes.get(change.id)?.undoneAt) return { ok: false, reason: "That change was already undone." };
    const out = { ok: false, reason: String(res?.reason ?? "Undo failed."), ...(res?.conflictWith ? { conflictWith: res.conflictWith } : {}) };
    c.changes.setError(change.id, out.reason);
    return out;
  }

  return {
    start,
    stop,
    ready,
    status,
    observeRaw,
    observeEvent: observeRaw,
    pinSession,
    enqueueNote,
    search,
    readPage,
    briefing,
    briefingAck,
    briefingReset,
    settingsGet,
    settingsSet,
    changes: changesList,
    undo,
    maintenance,
    refreshDerived: scheduleDerived,
    settings,
    deps,
    /** The live `cto_fact` mirror (§5.4): enqueue the proposal as a note. Never throws. */
    mirrorCtoFact: async (fact) => {
      try {
        await ready();
        return c?.parts ? await c.parts.mirrorCtoFact(fact) : { enqueued: false, reason: "off" };
      } catch {
        return { enqueued: false, reason: "failed" };
      }
    },
    /** Run one curator batch for a project now (the same path the timer takes). */
    async runCurator(slug, opts) {
      const ctx = await requireOn();
      return ctx.layer.curator.runBatch(slug, opts);
    },
    /** Run the weekly tidy-up now. */
    async runTidy(opts) {
      const ctx = await requireOn();
      return ctx.layer.tidy.run(opts);
    },
    // Foundation handles for the curator/capture layer — valid after `ready()` resolves.
    get store() {
      return c?.store ?? null;
    },
    get state() {
      return c?.state ?? null;
    },
    get registry() {
      return c?.registry ?? null;
    },
    get sessionMap() {
      return c?.sessionMap ?? null;
    },
    get queue() {
      return c?.queue ?? null;
    },
    get budget() {
      return c?.budget ?? null;
    },
    get changesLog() {
      return c?.changes ?? null;
    },
    get scanner() {
      return c?.scanner ?? null;
    },
    get briefings() {
      return c?.briefings ?? null;
    },
    get pageIndex() {
      return c?.pageIndex ?? null;
    },
    /** The wired parts (capture, trial, skills, …) — see wiring.mjs. */
    get parts() {
      return c?.parts ?? null;
    },
    /** The curator layer: curator, tidy, tombstones, rules, globalBlock, validator, undo, downgrade. */
    get layer() {
      return c?.layer ?? null;
    },
    effectiveFor,
  };
}
