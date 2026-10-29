// runLedger.mjs — the per-session LIVE run ledger (WS11 D11 / audit T1, T2).
//
// The stream interpreter feeds it the same facts the transcript will later contain (a tool call, a text/reasoning block, an
// inbox delivery); it builds runs with the SAME `createRunWalker` the canonical walk uses (transcriptRuns.mjs), so the live
// `toolRuns` frame and a canonical refetch can never disagree about what a run is. It owns:
//   - the ordered LAYOUT of the turn (run / text / reasoning blocks) the phone draws live;
//   - run REVISIONS ({epoch, gen, seq}) so a client keeps the newest value of a run, whatever order answers arrive in;
//   - BOUNDARY classification: an inbox item either draws (ends the run), is transparent, or is unknown — an unknown item is
//     resolved by a lookup while later events are BUFFERED, then replayed behind the boundary;
//   - provisional boundaries and the canonical REBUILD that repairs a guess.
// A boundary that cannot be classified in time is GUESSED as "draws" without a turn reset (nothing is dropped on a guess:
// a lost part is worse than a stale closed run) and marked provisional; the canonical rebuild repairs it.
// Dependency-injected, no I/O of its own.

import { activityView, computeRuns, createRunWalker, deliveryClassOf, isDelegateTool, runBoundaryOf, runView } from "./transcriptRuns.mjs";

const hasText = (s) => typeof s === "string" && s.trim() !== "";

/**
 * What the ledger keeps of a tool part: only what the wording reads (status, title, input) — and the OUTPUT only where a
 * rule needs it (a delegate call's job name). Everything else about a part lives on the canonical message.
 */
export function slimLedgerPart(part) {
  const state = part?.state && typeof part.state === "object" ? part.state : {};
  const kept = { status: state.status, ...(state.title !== undefined ? { title: state.title } : {}), input: state.input };
  if (isDelegateTool(part?.tool)) {
    if (typeof state.output === "string") kept.output = state.output;
    else if (typeof state.metadata?.output === "string") kept.metadata = { output: state.metadata.output };
  }
  return { ...part, state: kept };
}

/** The frame entry for one ledger part. */
function partEntry(L, part) {
  const at = L.walker.partRun.get(part.id);
  const run = at ? L.walker.runs.get(at.runId) : null;
  const meta = L.partMeta.get(part.id) ?? {};
  return {
    id: part.id,
    callID: part.callID ?? part.id,
    messageID: part.messageID ?? "",
    runId: at?.runId ?? "",
    ...(run && run.segments.length > 1 ? { segmentId: at.segmentId } : {}),
    tool: String(part.tool ?? ""),
    status: part.state?.status ?? "pending",
    ...(meta.childSessionId ? { childSessionId: meta.childSessionId } : {}),
    // The wording is the box's (transcriptRuns.mjs); the phone draws it as it is.
    activity: meta.activity,
  };
}

export function createRunLedger({
  epoch,
  emit,
  now = Date.now,
  setTimer = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimer = (h) => clearTimeout(h),
  /** `({sessionId, messageID}) => Promise<"draws"|"transparent"|{cls, user?}>` — resolves an unknown delivery. */
  classifyDelivered = null,
  /** `(sessionId) => Promise<messages[]>` — the canonical window for a rebuild. */
  rebuildFromCanonical = null,
  warn = (m, e) => console.warn(m, e?.message ?? e ?? ""),
  coalesceMs = 100,
  classifyTimeoutMs = 3000,
  bufferCap = 2000,
  /** A canonical read (rebuild / seed) that has not answered by then is abandoned: the ledger must never wait on it forever. */
  rebuildTimeoutMs = 10_000,
  /** A settled (finished-turn) ledger is kept this long for late splices, then evicted. */
  graceMs = 10 * 60_000,
  /** …and settled ledgers are evicted oldest-first beyond this many sessions. */
  maxSessions = 200,
}) {
  const sessions = new Map();
  /** sid -> the highest `gen` an evicted/rebuilt ledger reached: a later ledger (or a bare stamp) never goes BACK below it. */
  const genFloor = new Map();
  const rememberGen = (sid, gen) => {
    if (gen <= 1) return;
    genFloor.delete(sid);
    genFloor.set(sid, gen);
    if (genFloor.size > 2000) genFloor.delete(genFloor.keys().next().value);
  };
  /** sid -> the highest run revision `seq` an evicted ledger reached: a fresh ledger for a continued run counts on from it, so
   * its revisions are never below what clients already hold at the same `gen`. */
  const seqFloor = new Map();
  const rememberSeq = (sid, seq) => {
    if (seq <= 0) return;
    seqFloor.delete(sid);
    seqFloor.set(sid, seq);
    if (seqFloor.size > 2000) seqFloor.delete(seqFloor.keys().next().value);
  };
  /** inboxID -> { cls, reset } recorded at enqueue time. */
  const deliveryClass = new Map();

  const newState = (sid, walker = createRunWalker(0), gen = 1) => ({
    sid,
    walker,
    gen,
    layout: [],
    layoutKeys: new Set(),
    closedNew: new Set(),
    dirtyRuns: new Set(),
    dirtyParts: new Set(),
    partMeta: new Map(),
    parts: new Map(), // partId -> latest part (for frame entries)
    pending: null, // { token, buffer: [], timer } — a delivery being classified
    hold: null, // { buffer, timer, finish } — a canonical read (rebuild / seed) in flight: run events wait behind it
    provisional: null, // { token, inboxID, messageID }
    fresh: true, // no drawing user message seen yet: a turn already under way when this ledger began is seeded from history
    completedAt: null, // set when the execution ended; cleared by any later event
    rebuildLater: false,
    nextToken: 1,
    timer: null,
    lastAt: -Infinity,
    needsFull: false,
  });
  const ledger = (sid) => {
    let L = sessions.get(sid);
    if (!L) {
      sweep();
      sessions.set(sid, (L = newState(sid, createRunWalker(seqFloor.get(sid) ?? 0), genFloor.get(sid) ?? 1)));
    }
    return L;
  };

  // ---- settling and eviction -----------------------------------------------------------------------------------------
  // A finished turn needs no live layout (the canonical fetch covers it): it is left out of the connect snapshot, and evicted
  // after a grace period / beyond an LRU cap, so memory and the snapshot do not grow with every session that ever ran a tool.
  const isSettled = (L) => L.completedAt != null && !L.pending && !L.hold && !L.provisional;
  function evict(L) {
    if (L.timer != null) clearTimer(L.timer);
    rememberGen(L.sid, L.gen);
    rememberSeq(L.sid, L.walker.seq);
    sessions.delete(L.sid);
  }
  function sweep() {
    const t = now();
    const settled = [];
    for (const L of sessions.values()) {
      if (!isSettled(L)) continue;
      if (t - L.completedAt >= graceMs) evict(L);
      else settled.push(L);
    }
    settled.sort((a, b) => a.completedAt - b.completedAt);
    for (const L of settled) {
      if (sessions.size <= maxSessions) break;
      evict(L);
    }
  }

  const viewOf = (L, run) => runView(L.walker, run, { epoch, gen: L.gen, seq: run.seq });

  // ---- frames --------------------------------------------------------------------------------------------------------
  function buildFrame(L, { full = false, rebuilt = false, retired = [] } = {}) {
    const ids = full ? [...L.walker.order] : [...L.dirtyRuns];
    const runs = ids.map((id) => L.walker.runs.get(id)).filter(Boolean);
    const partIds = full ? [...L.parts.keys()] : [...L.dirtyParts];
    return {
      epoch,
      full,
      gen: L.gen,
      ...(rebuilt ? { rebuilt: true, retired } : {}),
      layout: [...L.layout],
      runs: runs.map((r) => viewOf(L, r)),
      closed: full ? runs.filter((r) => r.closed).map((r) => r.id) : [...L.closedNew],
      parts: partIds.map((id) => L.parts.get(id)).filter(Boolean).map((p) => partEntry(L, p)),
    };
  }
  function flush(L, opts) {
    if (L.timer != null) {
      clearTimer(L.timer);
      L.timer = null;
    }
    const full = opts?.full || L.needsFull;
    const idle = L.dirtyRuns.size === 0 && L.dirtyParts.size === 0 && L.closedNew.size === 0 && !full && !L.layoutDirty;
    if (idle) return;
    const frame = buildFrame(L, { ...opts, full });
    L.dirtyRuns.clear();
    L.dirtyParts.clear();
    L.closedNew.clear();
    L.needsFull = false;
    L.layoutDirty = false;
    L.lastAt = now();
    emit(L.sid, frame);
  }
  // ≤ 1 frame / coalesceMs: the leading edge fires at once, anything inside the window folds into one trailing frame.
  function schedule(L) {
    if (L.timer != null) return;
    const wait = L.lastAt + coalesceMs - now();
    if (wait <= 0) return flush(L);
    L.timer = setTimer(() => {
      L.timer = null;
      flush(L);
    }, wait);
  }

  // ---- applying items (the walker's input) ---------------------------------------------------------------------------
  const addLayout = (L, entry, key) => {
    if (L.layoutKeys.has(key)) return;
    L.layoutKeys.add(key);
    L.layout.push(entry);
    L.layoutDirty = true;
  };
  function closeOpen(L) {
    const closed = L.walker.end();
    if (closed) {
      L.closedNew.add(closed.id);
      L.dirtyRuns.add(closed.id);
    }
  }
  function resetTurn(L) {
    L.walker.reset();
    L.layout = [];
    L.layoutKeys.clear();
    L.parts.clear();
    L.partMeta.clear();
    L.dirtyRuns.clear();
    L.dirtyParts.clear();
    L.closedNew.clear();
    L.needsFull = true;
  }
  function applyItem(L, item) {
    switch (item.k) {
      case "tool": {
        const part = slimLedgerPart(item.part);
        const { run, created, newSegment } = L.walker.part(part, part.messageID ?? "");
        L.parts.set(part.id, part);
        L.partMeta.set(part.id, { activity: activityView(part), childSessionId: item.childSessionId ?? L.partMeta.get(part.id)?.childSessionId });
        L.dirtyRuns.add(run.id);
        L.dirtyParts.add(part.id);
        if (created || newSegment) {
          const segmentId = run.segments[run.segments.length - 1];
          addLayout(L, { kind: "run", id: run.id, segmentId }, `run:${run.id}:${segmentId}`);
        }
        return;
      }
      case "end":
        closeOpen(L);
        return;
      case "text":
        if (!hasText(item.text)) return;
        closeOpen(L);
        addLayout(L, { kind: "text", partID: item.partID, messageID: item.messageID }, `text:${item.partID}`);
        return;
      case "reasoning":
        if (!hasText(item.text)) return;
        L.walker.reasoning();
        addLayout(L, { kind: "reasoning", partID: item.partID, messageID: item.messageID }, `reasoning:${item.partID}`);
        return;
      case "boundary":
        if (item.cls !== "draws") return;
        closeOpen(L);
        if (item.reset) {
          resetTurn(L);
          L.fresh = false;
        }
        return;
      case "deliver":
        deliver(L, item);
        return;
      default:
    }
  }

  // ---- boundaries (inbox deliveries) ---------------------------------------------------------------------------------
  // Items that can only be placed correctly against history: a turn already running when this ledger began (a restart, an
  // eviction) has its run begun in a message the ledger never saw.
  const seedable = (item) => item.k === "tool" || ((item.k === "text" || item.k === "reasoning") && hasText(item.text));
  /** An event ARRIVED: the ledger is live again, then it is placed (or buffered). */
  function handle(L, item) {
    L.completedAt = null;
    route(L, item);
  }
  /** Place or buffer an event WITHOUT touching `completedAt`: a replayed event arrived earlier, and the turn may have ended since. */
  function route(L, item) {
    if (L.hold) {
      L.hold.buffer.push(item);
      if (L.hold.buffer.length >= bufferCap) {
        warn(`[run-ledger] ${L.sid}: buffer cap reached while reading canonical history; giving the read up`);
        L.hold.finish(null);
      }
      return;
    }
    if (L.pending) {
      L.pending.buffer.push(item);
      if (L.pending.buffer.length >= bufferCap) {
        warn(`[run-ledger] ${L.sid}: buffer cap reached while classifying a delivery; treating it as a boundary`);
        settle(L, L.pending.token, { cls: "draws", user: false }, true);
      }
      return;
    }
    if (L.fresh && seedable(item) && typeof rebuildFromCanonical === "function") {
      L.fresh = false;
      startHold(L, [item], (messages) => {
        if (messages) adopt(L, messages, { bump: false });
        L.needsFull = true;
      });
      return;
    }
    applyItem(L, item);
  }
  function replay(L, buffer) {
    for (const item of buffer) route(L, item);
  }
  function settle(L, token, result, provisional) {
    const p = L.pending;
    if (!p || p.token !== token) return;
    if (p.timer != null) clearTimer(p.timer);
    L.pending = null;
    L.provisional = provisional ? { token, inboxID: p.inboxID, messageID: p.messageID } : L.provisional;
    applyItem(L, { k: "boundary", cls: result.cls, reset: result.user === true });
    replay(L, p.buffer);
    schedule(L);
    maybeRebuild(L);
  }
  function deliver(L, ev) {
    const known = deliveryClass.get(ev.inboxID);
    if (known) {
      applyItem(L, { k: "boundary", cls: known.cls, reset: known.reset });
      return;
    }
    if (typeof classifyDelivered !== "function") {
      L.provisional = { token: L.nextToken++, inboxID: ev.inboxID, messageID: ev.messageID };
      applyItem(L, { k: "boundary", cls: "draws", reset: false });
      return;
    }
    const token = L.nextToken++;
    const p = { token, buffer: [], inboxID: ev.inboxID, messageID: ev.messageID, timer: null };
    L.pending = p;
    p.timer = setTimer(() => {
      warn(`[run-ledger] ${L.sid}: delivery ${ev.inboxID} did not classify in ${classifyTimeoutMs} ms; treating it as a boundary`);
      settle(L, token, { cls: "draws", user: false }, true);
    }, classifyTimeoutMs);
    let lookup;
    try {
      lookup = Promise.resolve(classifyDelivered({ sessionId: L.sid, messageID: ev.messageID }));
    } catch (e) {
      lookup = Promise.reject(e);
    }
    lookup.then(
      (r) => {
        const result = typeof r === "string" ? { cls: r, user: r === "draws" } : r;
        if (L.pending?.token === token) return settle(L, token, result, false);
        // Late: the guess already went out. Agreeing clears the mark; disagreeing repairs from canonical history.
        if (L.provisional?.token === token) {
          if (result.cls === "draws") L.provisional = null;
          else void rebuild(L);
        }
      },
      (e) => {
        warn(`[run-ledger] ${L.sid}: classifying ${ev.inboxID} failed`, e);
        settle(L, token, { cls: "draws", user: false }, true);
      },
    );
  }

  // ---- canonical reads: the repair of a guessed boundary (rebuild) and the seed of a ledger that began mid-turn -------------
  /** Hold run events behind ONE canonical read (bounded in time and in buffered events), then `apply(messages|null)` and replay. */
  function startHold(L, initial, apply) {
    const hold = { buffer: initial, done: false, timer: null, finish: null };
    L.hold = hold;
    hold.finish = (messages) => {
      if (hold.done) return;
      hold.done = true;
      if (hold.timer != null) clearTimer(hold.timer);
      if (sessions.get(L.sid) !== L) return; // the session was deleted / evicted meanwhile
      L.hold = null;
      apply(Array.isArray(messages) ? messages : null);
      replay(L, hold.buffer);
      schedule(L);
      maybeRebuild(L);
    };
    hold.timer = setTimer(() => {
      warn(`[run-ledger] ${L.sid}: canonical read did not answer in ${rebuildTimeoutMs} ms; continuing without it`);
      hold.finish(null);
    }, rebuildTimeoutMs);
    let read;
    try {
      read = Promise.resolve(rebuildFromCanonical(L.sid));
    } catch (e) {
      read = Promise.reject(e);
    }
    read.then(hold.finish, (e) => {
      warn(`[run-ledger] ${L.sid}: canonical read failed`, e);
      hold.finish(null);
    });
  }
  /** Run a deferred rebuild once nothing is in flight (a classification or another read). */
  function maybeRebuild(L) {
    if (!L.rebuildLater) return;
    if (!L.provisional) {
      L.rebuildLater = false;
      return;
    }
    if (L.pending || L.hold) return;
    L.rebuildLater = false;
    void rebuild(L);
  }
  /**
   * Replace the ledger's membership with the canonical walk over `messages` (only the turn in progress: from the last message
   * that DREW). Ledger parts canonical history does not contain yet (unsettled messages) keep their place at the end.
   * `bump` (a repair) raises `gen`; a seed does not (nothing was sent before it). Returns the retired run ids.
   */
  function adopt(L, messages, { bump }) {
    let from = 0;
    messages.forEach((m, i) => {
      if (m?.info?.role === "user" && runBoundaryOf(m) === "draws") from = i;
    });
    const canon = computeRuns(messages.slice(from), { startSeq: L.walker.seq });
    const oldIds = new Set(L.walker.order);
    const oldParts = L.walker.order.flatMap((id) => L.walker.runs.get(id)?.parts ?? []);
    const walker = canon.walker;
    // The ledger keeps only what the wording reads: canonical tool parts carry their whole output.
    for (const run of walker.runs.values()) run.parts = run.parts.map(slimLedgerPart);
    for (const part of oldParts) if (!walker.partRun.has(part.id)) walker.part(part, part.messageID ?? "");
    walker.touchAll();
    const retired = [...oldIds].filter((id) => !walker.runs.has(id));
    L.walker = walker;
    if (bump) {
      L.gen += 1;
      rememberGen(L.sid, L.gen);
    }
    // The layout keeps its text/reasoning entries and the run entries that still exist; new (run, segment) pairs are appended.
    const keep = L.layout.filter((e) => e.kind !== "run" || (walker.runs.has(e.id) && walker.runs.get(e.id).segments.includes(e.segmentId)));
    L.layout = keep;
    L.layoutKeys = new Set(keep.map((e) => (e.kind === "run" ? `run:${e.id}:${e.segmentId}` : `${e.kind}:${e.partID}`)));
    for (const id of walker.order) for (const segmentId of walker.runs.get(id).segments) addLayout(L, { kind: "run", id, segmentId }, `run:${id}:${segmentId}`);
    for (const id of [...L.parts.keys()]) if (!walker.partRun.has(id)) L.parts.delete(id);
    for (const id of walker.partRun.keys()) {
      if (L.parts.has(id)) continue;
      const part = walker.runs.get(walker.partRun.get(id).runId).parts.find((p) => p.id === id);
      L.parts.set(id, part);
      L.partMeta.set(id, { activity: activityView(part) });
    }
    L.dirtyRuns.clear();
    L.closedNew.clear();
    return retired;
  }
  async function rebuild(L) {
    if (!L.provisional) return;
    // A classification (or another read) in flight finishes first: a rebuild never starts under it.
    if (L.pending || L.hold) {
      L.rebuildLater = true;
      return;
    }
    const prior = L.provisional;
    L.provisional = null; // a second rebuild for the same token cannot start; a late lookup result is now ignored
    startHold(
      L,
      [],
      (messages) => {
        if (!messages) {
          L.provisional ??= prior; // nothing was repaired: keep the mark so a later trigger retries
          return;
        }
        const retired = adopt(L, messages, { bump: true });
        flush(L, { full: true, rebuilt: true, retired });
      },
    );
  }

  // ---- the interpreter's calls ----------------------------------------------------------------------------------------
  return {
    /** Record an inbox item's boundary class when it is enqueued (the outcome of mapping it, never `raw.type` alone). */
    onEnqueued(inboxID, raw) {
      if (typeof inboxID !== "string" || !inboxID) return;
      const cls = deliveryClassOf(raw);
      if (cls === "unknown") return;
      deliveryClass.set(inboxID, { cls, reset: raw?.type === "user" });
      if (deliveryClass.size > 2000) deliveryClass.delete(deliveryClass.keys().next().value);
    },
    onDelivered(sid, inboxID, messageID) {
      const L = ledger(sid);
      handle(L, { k: "deliver", inboxID, messageID });
      schedule(L);
    },
    /** A tool call changed: `part` is the canonical-shaped tool part (transcriptRuns' wording reads it). */
    onTool(sid, part, { childSessionId, handoff = false } = {}) {
      const L = ledger(sid);
      handle(L, handoff ? { k: "end" } : { k: "tool", part, childSessionId });
      schedule(L);
    },
    onText(sid, { partID, messageID, text }) {
      const L = ledger(sid);
      handle(L, { k: "text", partID, messageID, text });
      schedule(L);
    },
    onReasoning(sid, { partID, messageID, text }) {
      const L = ledger(sid);
      handle(L, { k: "reasoning", partID, messageID, text });
      schedule(L);
    },
    /** A compaction summary draws text: it ends the run, exactly as its canonical message does. */
    onCompacted(sid) {
      const L = ledger(sid);
      handle(L, { k: "boundary", cls: "draws", reset: false });
      schedule(L);
    },
    /** The execution ended: a final frame, and the repair of any provisional boundary. */
    onTurnComplete(sid, complete) {
      const L = sessions.get(sid);
      if (!L) return;
      flush(L);
      if (complete) {
        L.completedAt = now();
        if (L.provisional) void rebuild(L);
      }
      sweep();
    },
    /** The opencode stream (re)connected: a pending classification resolves NOW (before resync frames); a guess is repaired. */
    onReconnect(sid) {
      const L = sessions.get(sid);
      if (!L) return;
      if (L.pending) settle(L, L.pending.token, { cls: "draws", user: false }, true);
      flush(L); // the resolved boundary reaches clients BEFORE the resync's own frames
      if (L.provisional) void rebuild(L);
    },
    onDeleted(sid) {
      const L = sessions.get(sid);
      if (L?.timer != null) clearTimer(L.timer);
      if (L?.hold?.timer != null) clearTimer(L.hold.timer);
      if (L?.pending?.timer != null) clearTimer(L.pending.timer);
      sessions.delete(sid);
      genFloor.delete(sid);
      seqFloor.delete(sid);
    },
    /** `full:true` frames for every session with a non-empty, unsettled ledger (the connect snapshot). */
    snapshotFrames() {
      sweep();
      const out = [];
      for (const [sid, L] of sessions) {
        if (L.walker.order.length === 0 && L.layout.length === 0) continue;
        if (isSettled(L)) continue; // a finished turn: the canonical fetch covers it
        out.push({ kind: "stream", sub: "toolRuns", sessionId: sid, payload: buildFrame(L, { full: true }) });
      }
      return out;
    },
    /** What `opencode:messages` / `opencode:message` stamp from. */
    ledgerFor(sid) {
      const L = sessions.get(sid);
      return {
        epoch,
        gen: L?.gen ?? genFloor.get(sid) ?? 1,
        runView: (id) => {
          const run = L?.walker.runs.get(id);
          return run ? viewOf(L, run) : null;
        },
        runOfPart: (id) => L?.walker.partRun.get(id) ?? null,
      };
    },
    /** Test seam. */
    _state: (sid) => sessions.get(sid),
  };
}
