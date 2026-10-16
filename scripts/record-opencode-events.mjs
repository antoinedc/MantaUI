#!/usr/bin/env node
// record-opencode-events.mjs — record the raw opencode V1 event stream of ONE
// throwaway turn as JSON lines, for the stream-interpreter golden corpus
// (src/server/fixtures/opencodeV1Events/).
//
//   node scripts/record-opencode-events.mjs <out.jsonl> [options] -- <prompt>
//
// Options:
//   --base <url>          opencode server (default http://127.0.0.1:4096)
//   --model <prov/model>  explicit model (default: the box's own default)
//   --agent <name>        agent for the prompt (default: opencode's default)
//   --abort-after <ms>    POST /session/:id/abort this long after the prompt
//   --abort-after-tool <ms>  abort this long after the first tool part starts
//                         running (more reliable than --abort-after: opencode's
//                         time-to-first-token varies by 10+ s)
//   --command-template <t> register a slash command "rec-cmd" with this template
//                         (project-local opencode.json inside the scratch dir)
//                         and send the prompt as ITS arguments via /command
//                         instead of prompt_async
//   --compact             after the turn goes idle, compact the session
//                         (POST /session/:id/summarize; needs --model) and
//                         record until it settles again
//   --answer <label>      when a question is asked, reply with this option
//                         label (default: the first option offered)
//   --timeout <ms>        hard cap for the whole recording (default 150000)
//
// Safety (this runs against the user's live opencode):
//   * works only inside a scratch dir under /tmp (git-initialised, two files);
//   * the global /event stream carries EVERY session on the box, so an event is
//     kept only when it belongs to the session we created or one of its
//     children — nothing else is ever written to disk;
//   * the session (and any child sessions) is DELETED at the end, even on error;
//   * it never touches opencode's config and never restarts anything.
//
// Output is scrubbed before it is written (see `scrubEvent`): home paths become
// /home/user, the scratch dir becomes /tmp/manta-rec, and any token-looking
// field is dropped. One JSON object per line, in arrival order, with the
// global+scoped double delivery preserved (the interpreter must de-dup it).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_KEY_RE = /^(auth|token|accesstoken|refreshtoken|apikey|api_key|secret|password|authorization|credentials?)$/i;
const SCRATCH_PUBLIC = "/tmp/manta-rec";

/** Replace every occurrence of `needle` (if non-empty) in `s`. */
function replaceAll(s, needle, repl) {
  return needle ? s.split(needle).join(repl) : s;
}

/**
 * Scrub one raw event (deep copy). Pure — exported for tests.
 * @param {unknown} value
 * @param {{ scratchDir: string, home?: string }} ctx
 */
export function scrubEvent(value, ctx) {
  const home = ctx.home ?? homedir();
  const walk = (v) => {
    if (typeof v === "string") {
      let s = replaceAll(v, ctx.scratchDir, SCRATCH_PUBLIC);
      s = replaceAll(s, home, "/home/user");
      s = s.replace(/\/home\/dev\b/g, "/home/user");
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Every session id an event refers to (for ownership filtering). Pure. */
export function eventSessionIds(ev) {
  const p = ev?.properties ?? {};
  const ids = new Set();
  const add = (x) => { if (typeof x === "string" && x) ids.add(x); };
  add(p.sessionID);
  add(p.info?.sessionID);
  add(p.part?.sessionID);
  if (typeof ev?.type === "string" && ev.type.startsWith("session.")) add(p.info?.id);
  return ids;
}

function parseArgs(argv) {
  const dd = argv.indexOf("--");
  if (dd < 0) throw new Error("usage: record-opencode-events.mjs <out.jsonl> [options] -- <prompt>");
  const prompt = argv.slice(dd + 1).join(" ").trim();
  if (!prompt) throw new Error("empty prompt after --");
  const head = argv.slice(0, dd);
  const out = head[0];
  if (!out || out.startsWith("--")) throw new Error("first argument must be the output .jsonl path");
  const opts = { out, prompt, base: "http://127.0.0.1:4096", timeout: 150_000 };
  for (let i = 1; i < head.length; i++) {
    const k = head[i];
    const v = head[++i];
    if (k === "--base") opts.base = v;
    else if (k === "--model") opts.model = v;
    else if (k === "--agent") opts.agent = v;
    else if (k === "--abort-after") opts.abortAfter = Number(v);
    else if (k === "--abort-after-tool") opts.abortAfterTool = Number(v);
    else if (k === "--command-template") opts.commandTemplate = v;
    else if (k === "--compact") { opts.compact = true; i--; }
    else if (k === "--answer") opts.answer = v;
    else if (k === "--timeout") opts.timeout = Number(v);
    else throw new Error(`unknown option ${k}`);
  }
  return opts;
}

/** Minimal SSE reader: calls onData(string) per `data:` frame until aborted. */
async function readSse(url, signal, onData) {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`SSE ${url} -> ${res.status}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) onData(data);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync("/tmp/manta-rec-");
  // A real, tiny git repo so tools (edit / bash / todo) have something to work on.
  writeFileSync(join(scratch, "notes.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(scratch, "greet.js"), "export function greet(name) {\n  return 'hello ' + name;\n}\n");
  if (opts.commandTemplate) {
    writeFileSync(
      join(scratch, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", command: { "rec-cmd": { template: opts.commandTemplate } } }),
    );
  }
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  execFileSync("git", ["-c", "user.email=rec@example.invalid", "-c", "user.name=rec", "add", "-A"], { cwd: scratch });
  execFileSync("git", ["-c", "user.email=rec@example.invalid", "-c", "user.name=rec", "commit", "-qm", "init"], { cwd: scratch });

  const dirQ = `?directory=${encodeURIComponent(scratch)}`;
  const api = (p, init) => fetch(`${opts.base}${p}`, init);
  const owned = new Set();
  const created = [];
  const sink = createWriteStream(opts.out);
  const ac = new AbortController();
  let count = 0;
  let sawBusy = false;
  let idleAt = null;
  let mainId = null;
  let toolRunningAt = null;

  const onRaw = (data) => {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    const ids = eventSessionIds(ev);
    // Learn children before the ownership check so their own events are kept.
    if (ev.type === "session.created" && owned.has(ev.properties?.info?.parentID)) {
      const cid = ev.properties.info.id;
      owned.add(cid);
      created.push(cid);
    }
    if (![...ids].some((i) => owned.has(i))) return;
    sink.write(JSON.stringify(scrubEvent(ev, { scratchDir: scratch })) + "\n");
    count++;
    if (ev.properties?.sessionID === mainId) {
      if (ev.type === "session.status" && ev.properties?.status?.type !== "idle") sawBusy = true;
      if (ev.type === "session.idle" && sawBusy) idleAt = Date.now();
      const part = ev.properties?.part;
      if (ev.type === "message.part.updated" && part?.type === "tool" && part.state?.status === "running" && toolRunningAt == null) {
        toolRunningAt = Date.now();
      }
      if (ev.type === "question.asked") void answerQuestion(ev);
    }
  };

  async function answerQuestion(ev) {
    const qs = ev.properties?.questions ?? [];
    const answers = qs.map((q) => {
      const labels = (q.options ?? []).map((o) => o.label);
      return [labels.includes(opts.answer) ? opts.answer : (opts.answer ?? labels[0] ?? "ok")];
    });
    const r = await api(`/question/${encodeURIComponent(ev.properties.id)}/reply${dirQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    console.error(`[rec] question reply -> ${r.status}`);
  }

  let exitCode = 0;
  try {
    const r = await api(`/session${dirQ}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`create session ${r.status}: ${await r.text()}`);
    mainId = (await r.json()).id;
    owned.add(mainId);
    created.push(mainId);
    console.error(`[rec] session ${mainId} in ${scratch}`);

    const g = readSse(`${opts.base}/event`, ac.signal, onRaw).catch(() => {});
    const s = readSse(`${opts.base}/event${dirQ}`, ac.signal, onRaw).catch(() => {});
    await new Promise((res) => setTimeout(res, 700)); // let both subscriptions go live

    const body = { parts: [{ type: "text", text: opts.prompt }] };
    if (opts.model) {
      const [providerID, ...rest] = opts.model.split("/");
      body.model = { providerID, modelID: rest.join("/") };
    }
    if (opts.agent) body.agent = opts.agent;
    let pr;
    if (opts.commandTemplate) {
      const cbody = { command: "rec-cmd", arguments: opts.prompt };
      if (opts.model) cbody.model = opts.model;
      if (opts.agent) cbody.agent = opts.agent;
      // /command is synchronous (resolves when the command turn ends); do not await it here.
      pr = { ok: true };
      void api(`/session/${mainId}/command${dirQ}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cbody),
      }).then((r) => console.error(`[rec] command -> ${r.status}`)).catch(() => {});
    } else {
      pr = await api(`/session/${mainId}/prompt_async${dirQ}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    }
    if (!pr.ok) throw new Error(`prompt_async ${pr.status}: ${await pr.text()}`);
    const t0 = Date.now();

    let aborted = false;
    let compacted = false;
    while (Date.now() - t0 < opts.timeout) {
      await new Promise((res) => setTimeout(res, 200));
      if (opts.abortAfter != null && !aborted && Date.now() - t0 >= opts.abortAfter) {
        aborted = true;
        const ar = await api(`/session/${mainId}/abort${dirQ}`, { method: "POST" });
        console.error(`[rec] abort -> ${ar.status}`);
      }
      if (opts.abortAfterTool != null && !aborted && toolRunningAt != null && Date.now() - toolRunningAt >= opts.abortAfterTool) {
        aborted = true;
        const ar = await api(`/session/${mainId}/abort${dirQ}`, { method: "POST" });
        console.error(`[rec] abort (after tool) -> ${ar.status}`);
      }
      if (idleAt != null && Date.now() - idleAt >= 2000) {
        if (opts.compact && !compacted) {
          compacted = true;
          idleAt = null;
          sawBusy = false;
          // /session/:id/summarize is V1's compaction route (the /api/.../compact
          // route answers 503 "not available yet" on 1.18.x).
          const [providerID, ...mrest] = (opts.model ?? "").split("/");
          const cr = await api(`/session/${mainId}/summarize${dirQ}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providerID, modelID: mrest.join("/") }),
          });
          console.error(`[rec] compact -> ${cr.status}`);
          if (!cr.ok) break;
          continue;
        }
        break;
      }
    }
    if (idleAt == null) { console.error("[rec] WARNING: session never went idle before the timeout"); exitCode = 2; }
    ac.abort();
    await Promise.allSettled([g, s]);
  } catch (e) {
    console.error(`[rec] ERROR ${e?.message ?? e}`);
    exitCode = 1;
  } finally {
    ac.abort();
    await new Promise((res) => sink.end(res));
    // Children first, then the parent. Every id here is one we created.
    for (const id of [...created].reverse()) {
      try {
        const d = await api(`/session/${encodeURIComponent(id)}${dirQ}`, { method: "DELETE" });
        console.error(`[rec] delete ${id} -> ${d.status}`);
      } catch (e) {
        console.error(`[rec] delete ${id} FAILED ${e?.message ?? e}`);
        exitCode ||= 1;
      }
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    console.error(`[rec] ${count} events -> ${opts.out}`);
  }
  process.exit(exitCode);
}

// Only run when invoked directly (the helpers above are imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
