// opencodeV2.mjs — pure V2 → Manta-shape converters (OpenCode V2 cutover, slice C1).
//
// manta-server talks to OpenCode V2 but every client contract is unchanged
// (spec K2): `opencode:messages` still returns `{info, parts}[]`, the stream
// frames keep their shapes, questions/permissions keep the shapes the cards
// render. This module is the ONE place V2's wire shapes are translated. It is
// pure (no I/O) so it is unit-tested on recorded V2 payloads
// (src/server/fixtures/opencodeV2Events/) and shared by opencode.mjs (HTTP
// client), streamInterp.mjs (stream frames) and the lifecycle adapter below.
//
// V2 facts this module encodes (all verified live on 2.0.30, see
// docs/opencode-v2/spikes/):
//   * the timeline (`GET /api/session/{id}/message`) is a flat list of typed
//     records (user | assistant | compaction | idle | agent-switched | …); an
//     assistant record is ONE model step and carries `content[]` blocks —
//     text / reasoning have no id, tools carry their `toolu_…` id;
//   * V2 renamed tools: shell (was bash), subagent (was task); `path` (was
//     filePath); subagent input `agent` (was subagent_type);
//   * errors are `{type, message, status?}`, not V1's `{name, data}`.

// ===== tool names / inputs =====

const TOOL_NAME_FROM_V2 = { shell: "bash", subagent: "task" };
const TOOL_NAME_TO_V2 = { bash: "shell", task: "subagent", todowrite: "todo_write" };

/** The name the renderer and the other server modules know a V2 tool by. */
export function toolNameFromV2(name) {
  return TOOL_NAME_FROM_V2[name] ?? name;
}

/** V1/Manta permission key → the V2 permission `action`. */
export function permissionKeyToV2(key) {
  return TOOL_NAME_TO_V2[key] ?? key;
}

/** Add the V1 spellings the existing renderers read, without dropping V2's own fields. */
export function normalizeToolInput(v2Name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const out = { ...input };
  if (typeof out.path === "string" && out.filePath === undefined) out.filePath = out.path;
  if (v2Name === "subagent" && typeof out.agent === "string" && out.subagent_type === undefined) {
    out.subagent_type = out.agent;
  }
  return out;
}

// ===== tool card titles =====
//
// V1 computed `state.title` (the card header's command/target) itself; V2 does
// not, so manta derives it from the tool input. Accepts V2 and V1 tool names
// (migrated history still carries `bash` / `task` / `todowrite` / `filePath`).

const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** `p` relative to `directory` when inside it, else as given. */
function relativeToDirectory(p, directory) {
  if (typeof directory !== "string" || directory === "") return p;
  const dir = directory.length > 1 ? directory.replace(/\/+$/, "") : directory;
  if (p === dir) return ".";
  return p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
}

/**
 * The card-header text for a tool call, or undefined when there is nothing
 * sensible to show (Manta's own tools, MCP tools, input not known yet).
 * @param {string} name  V2 or V1 tool name
 * @param {any} input
 * @param {{directory?: string}} [opts]  the session's directory, for relative file paths
 */
export function toolTitle(name, input, { directory } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  switch (toolNameFromV2(String(name ?? ""))) {
    case "bash":
      return nonEmpty(input.command);
    case "read":
    case "edit":
    case "write": {
      const p = nonEmpty(input.filePath) ?? nonEmpty(input.path);
      return p === undefined ? undefined : relativeToDirectory(p, directory);
    }
    case "grep":
    case "glob":
      return nonEmpty(input.pattern);
    case "task":
      return nonEmpty(input.description);
    case "todo_write":
    case "todowrite": {
      if (!Array.isArray(input.todos)) return undefined;
      const pending = input.todos.filter((t) => t?.status !== "completed").length;
      return `${pending} todos`;
    }
    case "webfetch":
      return nonEmpty(input.url);
    case "websearch":
      return nonEmpty(input.query);
    default:
      return undefined;
  }
}

// ===== errors =====

const ERROR_NAME_FROM_V2 = {
  "provider.auth": "ProviderAuthError",
  "context.length": "ContextOverflowError",
  "output.length": "MessageOutputLengthError",
  aborted: "MessageAbortedError",
};

/** V2 `{type, message, status?, response?}` → V1 `{name, data:{message, statusCode?, …}}`. */
export function errorFromV2(err) {
  if (!err || typeof err !== "object") return undefined;
  const type = typeof err.type === "string" ? err.type : "";
  const name =
    ERROR_NAME_FROM_V2[type] ??
    (type.startsWith("provider.") || type === "" ? "ApiError" : "UnknownError");
  const message = typeof err.message === "string" && err.message ? err.message : type || "The turn failed.";
  const data = { message };
  if (typeof err.status === "number") {
    data.statusCode = err.status;
    // V2 retries retryable failures itself (session.retry.scheduled); an error
    // that finally surfaces is retryable only for rate limits / server faults.
    data.isRetryable = err.status === 429 || err.status >= 500;
  }
  const body = err.response?.body;
  if (typeof body === "string") data.responseBody = body;
  if (type) data.type = type;
  return { name, data };
}

// ===== tool output =====

/** Plain text of a V2 `Tool.Content[]` (files collapse to a one-line marker). */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c?.type === "text") return typeof c.text === "string" ? c.text : "";
      if (c?.type === "file") return `[file ${c.name ?? c.uri ?? ""} ${c.mime ?? ""}]`.replace(/\s+\]$/, "]");
      return "";
    })
    .join("");
}

const SUBAGENT_WRAP = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/;

/** The text a tool part shows as its output (a subagent's `<subagent>` wrapper is unwrapped). */
export function toolOutputText(v2Name, content) {
  const text = contentText(content);
  if (v2Name === "subagent") {
    const m = SUBAGENT_WRAP.exec(text);
    if (m) return m[1];
  }
  return text;
}

/** V2 tool metadata → the keys the renderer reads (`diff`/`filediff` for edits, `sessionId` for subagents). */
export function normalizeToolMetadata(v2Name, metadata, input) {
  const md = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (typeof md.sessionID === "string" && md.sessionId === undefined) md.sessionId = md.sessionID;
  if (v2Name === "subagent" && md.background === undefined && input && input.background === true) md.background = true;
  const files = Array.isArray(md.files) ? md.files : null;
  if (files && files.length > 0 && md.diff === undefined) {
    const patches = files.map((f) => f?.patch).filter((p) => typeof p === "string");
    if (patches.length > 0) md.diff = patches.join("\n");
    const f0 = files[0];
    if (files.length === 1 && f0 && typeof f0 === "object" && md.filediff === undefined) {
      md.filediff = { file: f0.file, patch: f0.patch, additions: f0.additions ?? 0, deletions: f0.deletions ?? 0 };
    }
  }
  return md;
}

// ===== timeline → {info, parts}[] =====

const clean = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

/** Map one V2 tool block (assistant `content[]` entry) to a V1-shaped tool part. */
export function mapToolBlock(block, { messageID, sessionID, directory }) {
  const v2Name = String(block.name ?? "");
  const st = block.state ?? {};
  const input = normalizeToolInput(v2Name, st.input && typeof st.input === "object" ? st.input : {});
  const time = block.time ?? {};
  const start = time.ran ?? time.created;
  const title = nonEmpty(st.title) ?? toolTitle(v2Name, input, { directory });
  const withTitle = title === undefined ? {} : { title };
  let state;
  switch (st.status) {
    case "streaming":
      // The input is still arriving as partial JSON text.
      state = { status: "pending", input: {}, raw: typeof st.input === "string" ? st.input : "" };
      break;
    case "running":
      state = { status: "running", input, ...withTitle, metadata: normalizeToolMetadata(v2Name, st.metadata, input), time: { start } };
      break;
    case "completed":
      state = {
        status: "completed",
        input,
        output: toolOutputText(v2Name, st.content),
        metadata: normalizeToolMetadata(v2Name, st.metadata, input),
        ...withTitle,
        time: { start, end: time.completed },
      };
      break;
    case "error":
      state = {
        status: "error",
        input,
        ...withTitle,
        error: typeof st.error?.message === "string" ? st.error.message : "The tool failed.",
        ...(Array.isArray(st.content) ? { output: toolOutputText(v2Name, st.content) } : {}),
        metadata: normalizeToolMetadata(v2Name, st.metadata, input),
        time: { start, end: time.completed },
      };
      break;
    default:
      state = { status: "pending", input };
  }
  return {
    id: String(block.id),
    callID: String(block.id),
    messageID,
    sessionID,
    type: "tool",
    tool: toolNameFromV2(v2Name),
    state,
  };
}

function mapAssistant(m, { sessionID, parentID, directory }) {
  const completed = m.time?.completed;
  const info = clean({
    id: m.id,
    sessionID,
    role: "assistant",
    parentID: parentID ?? undefined,
    time: clean({ created: m.time?.created, completed }),
    modelID: m.model?.id,
    providerID: m.model?.providerID,
    variant: m.model?.variant,
    agent: m.agent,
    mode: m.agent,
    tokens: m.tokens,
    cost: m.cost,
    finish: m.finish,
    error: errorFromV2(m.error),
  });
  const parts = [];
  const counters = { text: 0, reasoning: 0 };
  for (const block of Array.isArray(m.content) ? m.content : []) {
    if (block?.type === "text") {
      parts.push({
        id: `${m.id}:text:${counters.text++}`,
        messageID: m.id,
        sessionID,
        type: "text",
        text: String(block.text ?? ""),
      });
    } else if (block?.type === "reasoning") {
      parts.push({
        id: `${m.id}:reasoning:${counters.reasoning++}`,
        messageID: m.id,
        sessionID,
        type: "reasoning",
        text: String(block.text ?? ""),
        time: block.time ? { start: block.time.created, end: block.time.completed } : undefined,
      });
    } else if (block?.type === "tool") {
      parts.push(mapToolBlock(block, { messageID: m.id, sessionID, directory }));
    }
  }
  if (m.tokens) {
    // A V1 step ended with a `step-finish` part carrying usage; the token
    // selectors and the stepEnded replay read it from there.
    parts.push(
      clean({
        id: `${m.id}:step-finish`,
        messageID: m.id,
        sessionID,
        type: "step-finish",
        reason: m.rawFinish ?? m.finish,
        cost: m.cost,
        tokens: m.tokens,
      }),
    );
  }
  return { info, parts };
}

function mapUser(m, { sessionID }) {
  const parts = [
    { id: `${m.id}:text:0`, messageID: m.id, sessionID, type: "text", text: String(m.text ?? "") },
  ];
  (m.files ?? []).forEach((f, i) => {
    const uri = f?.source?.type === "uri" ? f.source.uri : null;
    parts.push(
      clean({
        id: `${m.id}:file:${i}`,
        messageID: m.id,
        sessionID,
        type: "file",
        mime: f?.mime,
        filename: f?.name,
        url: uri ?? (typeof f?.data === "string" ? `data:${f?.mime ?? "application/octet-stream"};base64,${f.data}` : undefined),
      }),
    );
  });
  (m.agents ?? []).forEach((a, i) => {
    parts.push({ id: `${m.id}:agent:${i}`, messageID: m.id, sessionID, type: "agent", name: a?.name });
  });
  return {
    info: { id: m.id, sessionID, role: "user", time: { created: m.time?.created } },
    parts,
  };
}

/**
 * A background child's result, posted into its parent as a `synthetic` record
 * (metadata.source "subagent"; opencode posts it for V2-native background
 * commands and `task` subagents, Manta posts it for runs it wrapped). The text
 * is `<subagent sessionID="…" state="…" description="…">\n…\n</subagent>` —
 * V2 does NOT entity-encode either the attributes or the body (recorded: a
 * body containing `</subagent>` and a description containing `<`/`>`/`"` come
 * back raw), so the envelope is peeled by exact prefix/suffix, never by
 * parsing. A missing or unrecognised envelope yields the raw text.
 */
function backgroundResultText(raw, { childID, state, description }) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.startsWith("<subagent")) return text;
  const attrs = (d) => `<subagent sessionID="${childID}" state="${state}"${d === undefined ? "" : ` description="${d}"`}>`;
  const candidates = [];
  if (childID && state) {
    if (typeof description === "string") candidates.push(attrs(description));
    candidates.push(attrs(undefined));
  }
  let open = candidates.find((c) => text.startsWith(c));
  if (open === undefined) {
    // Metadata missing: the envelope's own attributes (description is the one
    // unescaped free-text attribute, so it ends at the first `">`).
    const m = text.match(/^<subagent\s+sessionID="[^"]*"\s+state="[^"]*"(?:\s+description="[\s\S]*?")?>/);
    if (!m) return text;
    open = m[0];
  }
  let inner = text.slice(open.length);
  if (inner.endsWith("</subagent>")) inner = inner.slice(0, -"</subagent>".length);
  else return text;
  if (inner.startsWith("\n")) inner = inner.slice(1);
  if (inner.endsWith("\n")) inner = inner.slice(0, -1);
  return inner;
}

// Manta posts its results as `[background job "<name>" <status>]` + a blank line
// + the body. The card already shows the name and state, so its text drops that
// header (the model still receives the full text). Anything else is untouched.
function stripMantaResultHeader(text) {
  const m = text.match(/^\[background job ".*" [^\]\n]*\](?:\n|$)/);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

function envelopeAttr(text, name) {
  const m = typeof text === "string" ? text.match(new RegExp(`^<subagent[^>]*?\\s${name}="([^"]*)"`)) : null;
  return m ? m[1] : undefined;
}

function mapBackgroundResult(m, { sessionID }) {
  const md = m.metadata;
  const childSessionId =
    (typeof md.childID === "string" && md.childID) || envelopeAttr(m.text, "sessionID");
  if (!childSessionId) return null; // nothing to pair or open it by
  const state = (typeof md.state === "string" && md.state) || envelopeAttr(m.text, "state") || "unknown";
  const manta = md.manta && typeof md.manta === "object" ? md.manta : {};
  const description = typeof m.description === "string" ? m.description : undefined;
  const name =
    (typeof manta.name === "string" && manta.name) ||
    (description !== undefined && description.startsWith("/") ? description : undefined);
  const jobId = typeof manta.jobId === "string" && manta.jobId ? manta.jobId : undefined;
  let text = backgroundResultText(m.text, { childID: childSessionId, state, description });
  if (jobId) text = stripMantaResultHeader(text);
  return {
    // `completed` is stamped too: several readers (isAssistantTurnInProgress,
    // peers' classifyChatStatus, the CTO run outcome) read an assistant message
    // without it as a turn still running — and a result is by nature finished.
    info: {
      id: m.id,
      sessionID,
      role: "assistant",
      time: { created: m.time?.created, completed: m.time?.created },
      background: true,
    },
    parts: [
      clean({
        id: `${m.id}:bg`,
        messageID: m.id,
        sessionID,
        type: "background-result",
        childSessionId,
        jobId,
        state,
        name,
        agent: typeof md.agent === "string" && md.agent ? md.agent : undefined,
        text,
      }),
    ],
  };
}

/**
 * V2 timeline records (CHRONOLOGICAL) → the `{info, parts}[]` shape every
 * client reads (src/shared/types.ts OpencodeMessage). Records that are not
 * conversation (idle, agent/model/location switches, system, skill, shell,
 * other synthetic input) are dropped; a background child's result (synthetic,
 * metadata.source "subagent") becomes a `background-result` message. `directory` (the session's) lets file tools' card
 * titles show paths relative to it. A completed compaction becomes a `summary:true`
 * assistant message holding the summary text.
 */
export function mapTimeline(items, { sessionID, directory } = {}) {
  const out = [];
  let lastUser = null;
  for (const m of Array.isArray(items) ? items : []) {
    if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
    if (m.type === "user") {
      lastUser = m.id;
      out.push(mapUser(m, { sessionID }));
    } else if (m.type === "assistant") {
      out.push(mapAssistant(m, { sessionID, parentID: lastUser, directory }));
    } else if (m.type === "synthetic" && m.metadata?.source === "subagent") {
      const mapped = mapBackgroundResult(m, { sessionID });
      if (mapped) out.push(mapped);
    } else if (m.type === "compaction" && m.status === "completed") {
      out.push({
        info: clean({
          id: m.id,
          sessionID,
          role: "assistant",
          parentID: lastUser ?? undefined,
          summary: true,
          time: { created: m.time?.created, completed: m.time?.created },
          modelID: m.model?.id,
          providerID: m.model?.providerID,
          tokens: m.tokens,
          cost: m.cost,
        }),
        parts: [{ id: `${m.id}:text:0`, messageID: m.id, sessionID, type: "text", text: String(m.summary ?? "") }],
      });
    }
  }
  return out;
}

// ===== sessions =====

/** V2 Session.Info → the V1 session record callers read (`directory`, `title`, …). */
export function sessionFromV2(s) {
  if (!s || typeof s !== "object") return s;
  return {
    ...s,
    directory: typeof s.location?.directory === "string" ? s.location.directory : "",
    title: typeof s.title === "string" ? s.title : "",
  };
}

// ===== permissions & forms (questions) =====

/** V2 permission request → the V1 shape the PermissionCard / push / trust mode read. */
export function permissionFromV2(p) {
  if (!p || typeof p !== "object") return p;
  const resources = Array.isArray(p.resources) ? p.resources : [];
  const action = typeof p.action === "string" ? p.action : "";
  const first = resources[0];
  const metadata = {};
  if (typeof first === "string") {
    if (action === "shell") metadata.command = first;
    else metadata.filepath = first;
  }
  const src = p.source && typeof p.source === "object" ? p.source : null;
  return {
    id: p.id,
    sessionID: p.sessionID,
    permission: action === "shell" ? "bash" : action,
    patterns: resources,
    always: Array.isArray(p.save) ? p.save : [],
    metadata,
    ...(src?.messageID && src?.id ? { tool: { messageID: src.messageID, callID: src.id } } : {}),
  };
}

/** Is this V2 form the model's `question` tool (as opposed to e.g. an OAuth form)? */
export function isQuestionForm(form) {
  return form?.metadata?.kind === "question";
}

/** V2 question form → the V1 QuestionRequest `{id, sessionID, questions[], tool}`; `id` stays the form id (the reply key). */
export function questionFromForm(form) {
  if (!form || typeof form !== "object") return form;
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const questions = fields.map((f) =>
    clean({
      question: String(f.description ?? f.title ?? ""),
      header: String(f.title ?? ""),
      options: (Array.isArray(f.options) ? f.options : []).map((o) =>
        clean({ label: String(o.label ?? o.value ?? ""), description: o.description }),
      ),
      multiple: f.type === "multiselect" ? true : undefined,
      custom: f.custom === false ? false : true,
    }),
  );
  const tool = form.metadata?.tool;
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions,
    ...(tool?.messageID && tool?.id ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
  };
}

/**
 * V1 `answers: string[][]` (one array of labels per question) → V2 form answer
 * `{[fieldKey]: value}` for the given form's fields, in field order.
 */
export function formAnswerFromAnswers(form, answers) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const out = {};
  fields.forEach((f, i) => {
    const picked = Array.isArray(answers?.[i]) ? answers[i].map(String) : [];
    out[f.key] = f.type === "multiselect" ? picked : picked.join(", ");
  });
  return out;
}

// ===== lifecycle adapter (for the server modules that watch session state) =====
//
// The stream interpreter consumes raw V2 events. The OTHER server modules that
// observe the firehose (promptDelivery, delegate, push, the CTO admission /
// segments / evidence, seat-retry, usage-resume, …) only need a handful of
// lifecycle facts (busy / idle / error / retry / a tool finished / ask raised
// or answered / session created). `createLifecycleAdapter()` derives exactly
// those, in the small V1-shaped vocabulary those modules already speak, so each
// of them keeps its own tests and logic. It is a translation layer, not a
// fallback: nothing here talks to a V1 server.

/** @returns {{ adapt: (evt: any) => any[] }} */
export function createLifecycleAdapter() {
  const tools = new Map(); // toolID -> { name, input, messageID }
  const models = new Map(); // sessionID -> { providerID, modelID }
  const stepFinish = new Map(); // sessionID -> last rawFinish
  const bound = (m, cap = 2000) => {
    if (m.size <= cap) return;
    let drop = m.size - cap / 2;
    for (const k of m.keys()) {
      if (drop-- <= 0) break;
      m.delete(k);
    }
  };

  function toolPart(sessionID, d, status, extra = {}) {
    const known = tools.get(d.id) ?? {};
    const v2Name = known.name ?? "";
    const input = normalizeToolInput(v2Name, known.input ?? {});
    const title = toolTitle(v2Name, input, { directory: known.directory });
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: String(d.id),
          callID: String(d.id),
          messageID: d.assistantMessageID ?? known.messageID,
          sessionID,
          type: "tool",
          tool: toolNameFromV2(v2Name),
          state: { status, input, ...(title === undefined ? {} : { title }), ...extra },
        },
      },
    };
  }

  function adapt(evt) {
    if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return [];
    const d = evt.data ?? {};
    const sid = typeof d.sessionID === "string" ? d.sessionID : undefined;
    const withId = (e) => (evt.id ? { id: evt.id, ...e } : e);
    switch (evt.type) {
      case "session.execution.started":
        return [withId({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } })];
      case "session.execution.succeeded":
        return [
          { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
          { type: "session.idle", properties: { sessionID: sid } },
        ];
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const failed = evt.type === "session.execution.failed";
        const error = failed
          ? errorFromV2(d.error)
          : { name: "MessageAbortedError", data: { message: "The operation was aborted." } };
        const out = [{ type: "session.error", properties: { sessionID: sid, error } }];
        const m = failed ? models.get(sid) : null;
        if (m) {
          // An account-level refusal (429/402) feeds the provider health registers.
          out.push({
            type: "message.updated",
            properties: { sessionID: sid, info: { id: `${sid}:failed`, sessionID: sid, role: "assistant", ...m, error } },
          });
        }
        out.push(
          { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
          { type: "session.idle", properties: { sessionID: sid } },
        );
        return out;
      }
      case "session.retry.scheduled":
        return [
          withId({
            type: "session.status",
            properties: {
              sessionID: sid,
              status: {
                type: "retry",
                attempt: d.attempt,
                message: String(d.error?.message ?? ""),
                next: d.at,
                ...(typeof d.error?.status === "number" ? { statusCode: d.error.status } : {}),
              },
            },
          }),
        ];
      case "session.step.started":
        if (sid && d.model) models.set(sid, { providerID: d.model.providerID, modelID: d.model.id });
        bound(models);
        return [];
      case "session.step.ended":
        if (sid) stepFinish.set(sid, d.rawFinish);
        bound(stepFinish);
        return [
          withId({
            type: "session.next.step.ended",
            properties: {
              sessionID: sid,
              messageID: d.assistantMessageID,
              finish: d.rawFinish ?? d.finish,
              tokens: d.tokens,
              cost: d.cost,
              ...(sid && models.has(sid) ? models.get(sid) : {}),
            },
          }),
        ];
      case "session.tool.input.started":
        tools.set(d.id, { name: d.name, input: {}, messageID: d.assistantMessageID, directory: evt.location?.directory });
        bound(tools);
        return [];
      case "session.tool.called": {
        const k = tools.get(d.id) ?? { messageID: d.assistantMessageID };
        tools.set(d.id, { ...k, input: d.input ?? {}, directory: evt.location?.directory ?? k.directory });
        return [toolPart(sid, d, "running")];
      }
      case "session.tool.progress": {
        const md = d.metadata ?? {};
        // Only a subagent's progress is a lifecycle fact (the child session id).
        if (typeof md.sessionID === "string") {
          const known = tools.get(d.id) ?? {};
          return [
            toolPart(sid, d, "running", {
              metadata: { sessionId: md.sessionID, background: known.input?.background === true },
            }),
          ];
        }
        return [];
      }
      case "session.tool.success":
        return [
          toolPart(sid, d, "completed", {
            metadata: normalizeToolMetadata(tools.get(d.id)?.name, d.metadata, tools.get(d.id)?.input),
          }),
        ];
      case "session.tool.failed":
        return [toolPart(sid, d, "error", { error: String(d.error?.message ?? "") })];
      case "permission.asked":
        return [withId({ type: "permission.asked", properties: permissionFromV2({ ...d }) })];
      case "permission.replied":
        return [
          withId({
            type: "permission.replied",
            properties: { sessionID: sid, requestID: d.requestID, reply: d.reply },
          }),
        ];
      case "form.created":
        if (!isQuestionForm(d.form)) return [];
        return [withId({ type: "question.asked", properties: questionFromForm(d.form) })];
      case "form.replied":
        return [withId({ type: "question.replied", properties: { sessionID: sid, requestID: d.id } })];
      case "form.cancelled":
        return [withId({ type: "question.rejected", properties: { sessionID: sid, requestID: d.id } })];
      case "session.created":
        return [
          withId({
            type: "session.created",
            properties: {
              sessionID: sid,
              info: { id: sid, parentID: d.parentID, directory: d.location?.directory ?? evt.location?.directory },
            },
          }),
        ];
      case "session.deleted":
        return [withId({ type: "session.deleted", properties: { sessionID: sid } })];
      case "session.inbox.enqueued":
        if (d.item?.type === "user") {
          return [
            withId({
              type: "user.message.created",
              properties: { sessionID: sid, message: { role: "user", text: String(d.item.payload?.text ?? "") } },
            }),
          ];
        }
        return [];
      default:
        return [];
    }
  }
  return { adapt };
}
