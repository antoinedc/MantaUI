// A fake opencode + tmux + disk for the handoff engine tests. Nothing here
// touches a real opencode, tmux or ~/.manta — the engine reaches the world only
// through the objects built below, and "disk" is a string the test owns, so a
// crash is simulated by building a second engine on the same disk and world.

import { createHandoffEngine } from "./engine.mjs";
import { TEMPLATE_HEADINGS } from "./text.mjs";

export const FULL_BODY = TEMPLATE_HEADINGS.map((h) => `## ${h}\nsomething about ${h}`).join("\n\n");

export class Crash extends Error {
  constructor(at) {
    super(`simulated crash at ${at}`);
    this.crash = true;
    this.at = at;
  }
}

export const httpError = (status, msg = "refused") => Object.assign(new Error(`opencode ${status}: ${msg}`), { status });

export function createWorld({ mode = "auto" } = {}) {
  const w = {
    mode,
    sessions: new Map(),
    messages: new Map(), // sid -> Map(id -> {id, text, args})
    inbox: new Map(),
    active: new Set(),
    windows: [],
    posts: [], // every sendPrompt/postSynthetic call, accepted or not
    created: [],
    deleted: [],
    repointed: [],
    cleared: [],
    published: [],
    heldFailures: [],
    timers: [],
    disk: { json: null },
    failures: { send: [], create: [], generate: [] }, // queues of {status?, land?, hang?}
    generateText: FULL_BODY,
    generateCalls: [],
    crashAt: null,
    seq: 0,
  };

  w.addSession = (id, props = {}) => {
    const s = { id, directory: "/proj", title: `title ${id}`, agent: "build", model: { providerID: "anthropic", id: "claude-opus-4-8", variant: "high" }, permissions: [{ action: "shell", resource: "*", effect: "allow" }], ...props };
    w.sessions.set(id, s);
    return s;
  };
  w.addWindow = (sessionName, windowIndex, name, sid) => w.windows.push({ sessionName, windowIndex, name, cwd: "/proj", sid });
  const msgs = (sid) => (w.messages.get(sid) ?? w.messages.set(sid, new Map()).get(sid));
  w.accepted = (sid) => [...msgs(sid).values()];
  w.acceptedIds = (sid) => [...msgs(sid).keys()];

  const accept = (target, id, text, args) => {
    if (!msgs(target).has(id)) msgs(target).set(id, { id, text, args });
  };
  const failureFor = (queue) => (w.failures[queue].length ? w.failures[queue].shift() : null);

  const oc = {
    readSession: async (id) => (w.sessions.has(id) ? { state: "found", session: { ...w.sessions.get(id), location: { directory: w.sessions.get(id).directory } } } : { state: "missing" }),
    createSession: async (input) => {
      const f = failureFor("create");
      if (f) {
        if (f.land) {
          w.sessions.set(input.id, { id: input.id, ...input });
          w.created.push(input);
        }
        throw f.status ? httpError(f.status) : new Error("network down");
      }
      if (w.sessions.has(input.id)) return;
      w.sessions.set(input.id, { id: input.id, directory: input.directory, agent: input.agent, model: input.model && { providerID: input.model.providerID, id: input.model.modelID, variant: input.model.variant }, permissions: input.permissions, parentID: input.parentID });
      w.created.push(input);
    },
    deleteSession: async (id) => {
      w.deleted.push(id);
      w.sessions.delete(id);
    },
    generate: async (id, prompt) => {
      w.generateCalls.push({ id, prompt });
      const f = failureFor("generate");
      if (f) throw f.status ? httpError(f.status) : new Error("timeout");
      return typeof w.generateText === "function" ? w.generateText(id) : w.generateText;
    },
    sendPrompt: async (args) => {
      w.posts.push({ kind: "prompt", target: args.sessionId, id: args.messageID, text: args.text, args });
      const f = failureFor("send");
      if (f) {
        if (f.land) accept(args.sessionId, args.messageID, args.text, args);
        if (f.park) await f.park;
        throw f.status ? httpError(f.status) : new Error("connection reset");
      }
      if (args.park) await args.park;
      accept(args.sessionId, args.messageID, args.text, args);
    },
    postSynthetic: async (target, body) => {
      w.posts.push({ kind: "synthetic", target, id: body.id, text: body.text, args: body });
      const f = failureFor("send");
      if (f) {
        if (f.land) accept(target, body.id, body.text, body);
        throw f.status ? httpError(f.status) : new Error("connection reset");
      }
      accept(target, body.id, body.text, body);
    },
    listInbox: async (id) => w.inbox.get(id) ?? [],
    getMessage: async (sid, mid) => msgs(sid).get(mid) ?? null,
    listActive: async () => [...w.active],
  };

  const tmux = {
    findWindow: async (sid) => w.windows.find((x) => x.sid === sid) ?? null,
    findWindowByName: async (name) => w.windows.find((x) => x.name === name) ?? null,
    restamp: async (sessionName, windowIndex, sid) => {
      const win = w.windows.find((x) => x.sessionName === sessionName && x.windowIndex === windowIndex);
      win.sid = sid;
    },
    createStampedWindow: async ({ sessionName, tempName, cwd, sessionId }) => {
      const idx = 100 + w.windows.length;
      w.windows.push({ sessionName, windowIndex: idx, name: tempName, cwd, sid: sessionId });
      return idx;
    },
    rename: async ({ sessionName, windowIndex, newName }) => {
      w.windows.find((x) => x.sessionName === sessionName && x.windowIndex === windowIndex).name = newName;
    },
  };

  w.build = (overrides = {}) =>
    createHandoffEngine({
      load: () => (w.disk.json ? JSON.parse(w.disk.json) : null),
      save: async (snap) => {
        w.disk.json = JSON.stringify(snap);
      },
      now: () => (w.clock += 1),
      getMode: () => w.mode,
      publish: (e) => w.published.push(e),
      warn: () => {},
      oc,
      tmux,
      ownership: { repoint: async (pred, succ) => void w.repointed.push([pred, succ]) },
      onPendingSendCleared: (sid) => w.cleared.push(sid),
      onHeldFailure: (f) => w.heldFailures.push(f),
      gather: { facts: async () => null, measureContext: async () => null },
      contextLimitFor: () => 1_000_000,
      hooks: { step: async (name) => { if (w.crashAt === name) throw new Crash(name); } },
      timers: { setTimeout: (fn) => { w.timers.push(fn); return { unref() {} }; } },
      sleep: async () => {},
      retryDelayMs: 0,
      quietDelayMs: 0,
      mintSessionId: () => `ses_new${++w.seq}`,
      mintMessageId: () => `msg_n${++w.seq}`,
      mintRecordId: () => `hof_rec${++w.seq}`,
      ...overrides,
    });
  w.clock = 1_000;
  w.runTimers = async () => {
    const t = w.timers.splice(0);
    for (const fn of t) await fn();
    await settle();
  };
  return w;
}

/** Let detached promise chains run to completion (several microtask/macrotask turns). */
export async function settle(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** A world with a predecessor conversation in a window and an engine, ready to hand off. */
export function standardWorld(opts = {}) {
  const w = createWorld(opts);
  w.addSession("ses_p");
  w.addWindow("proj", 3, "work", "ses_p");
  w.engine = w.build();
  return w;
}

/** Create a ready (card) record on ses_p via the agent path. */
export async function readyRecord(w, { sessionId = "ses_p", engine = w.engine, trigger = "agent" } = {}) {
  const r = await engine.create({ sessionId, trigger, action: "suggest", body: FULL_BODY });
  if (r.state !== "ready") throw new Error(`expected ready, got ${r.state}`);
  return r;
}
