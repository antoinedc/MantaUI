# Agents — Phase 4: Manta creates and edits agents ("Architect")

Status: revised after Astra review rounds 1–2 (2026-11-23). Owner: Antoine. Builds on Phases 1–3c
(`2026-11-22-agents-phase1.md`, `…-phase2.md`, `2026-11-23-agents-phase3-autonomy.md`,
`…-phase3c-judgement-and-action-map.md`). **Speed rule: smallest usable version; edge cases become follow-ups.** Ship to
`main`, no release tags.

## 1. What the user gets

1. **"Make me an agent that…"** In a chat Manta leads, the user describes an agent. Manta drafts it — name, one-line
   description, when to use it / not for, model (or Auto), whether it edits code (own branch) or is read-only, and its
   instructions — and creates it with one tool call.
2. **"Change Dev so that…"** Manta edits an existing agent the same way (only the fields it names).
3. **A card in the chat for every change**, drawn by the app from the server's record: the new agent, or a line diff of
   the change. The "Change an agent" level decides:
   - **Auto / Tell me:** applied at once; the card says "Created" / "Updated" with **Undo**.
   - **Ask:** nothing is written; the card itself is the question — **Create** / **Apply** and **Discard**. Manta does
     not ask in words first; it proposes and the click decides.
   - **Never:** refused; Manta says it is turned off in Settings → Agents.
4. **Always a click, whatever the level,** for changes that raise power: any change to Manta itself (the lead), and
   turning an existing read-only agent into one that edits code. (A NEW agent follows the level, read-only or not.)
5. A created agent is usable at once: Manta can hand work to it in the same chat (handoff finds agents fresh). It
   appears in the sidebar on every open desktop right away. Manta's own team list in an already-open chat only refreshes
   on a new chat or after compaction (same stale-brief limit as the settings follow-up); the tool reply tells Manta the
   new agent exists and its slug.

Out of scope (follow-ups): deleting/archiving agents, per-agent tool/skill lists, per-project briefs authored by Manta,
an agent profile page, editing agents from Settings, device-bound approvals (§5), changing the lead's model or isolation.

## 2. Contracts (committed first)

### 2.1 Types — `src/shared/types.ts`

```ts
export interface AgentDraftCreate {           // create: every required field
  name: string; description: string; isolation: "worktree" | "none"; instructions: string;
  useWhen?: string | null; notFor?: string | null; model?: string | null; color?: string | null;
}
export type AgentDraftUpdate = Partial<AgentDraftCreate>; // update: ≥ 1 field; omitted = unchanged; null = clear (nullable fields only)
export type AgentChangeState = "applied" | "pending" | "discarded" | "undone" | "expired" | "conflict" | "failed";
// failed = the FILE was written but activating it (sync / config reload) failed; Retry only re-activates.
export interface AgentChange {
  id: string;                                 // "ach_" + 16 hex
  kind: "create" | "update";
  slug: string | null;                        // update: target; create: the claimed slug once written
  agentName: string;
  sessionID: string; messageID: string; callID: string; // the lead's tool call that made it (card lookup key)
  state: AgentChangeState;
  needsClick: boolean;
  reason: "ask" | "lead" | "isolation" | null;
  before: string | null;                      // exact agent.md bytes before (update)
  after: string;                              // exact agent.md bytes that will be / were written
  createdAt: number; decidedAt: number | null;
  error: string | null;                       // a sentence (failed / conflict / refused at click time)
}
```

Channels (`src/shared/api.ts` + `httpApi.ts`): `agentsChangeFor({sessionID, messageID, callID}) → AgentChange | null`,
`agentsChangeApply(id)`, `agentsChangeDiscard(id)`, `agentsChangeUndo(id)` → `AgentChange` (or a thrown sentence), and
event `onAgentChange(cb: (p: {id, sessionID, slug|null}) => void)` (bus kind `agentChange`).

### 2.2 Field rules (server, pinned)

- name 1–NAME_MAX one line; description 1–DESCRIPTION_MAX one line; useWhen/notFor ≤ ROUTING_MAX one line;
  isolation `worktree|none`; color `^#[0-9A-Fa-f]{6}$`; instructions 1–12,000 chars (trimmed).
- model: must be in the box's Sub-approved catalogue (the same check delegate uses for explicit models); an unavailable
  catalogue refuses with "Couldn't check the models; try again", an unknown model with "<model> isn't an approved model;
  pick one of …". An update that omits `model` keeps the current pin untouched.
- The lead (role `lead`): only `instructions`, `description`, `name`, `color` may change; `model`/`isolation`/`role` are
  refused. A specialist's `role` never changes. A create can never use the reserved lead slug or set `role`.

### 2.3 Tool (lead only) — `agent_change` in `docs/opencode-plugins-v2/manta/tools/agents.ts`

```
agent_change({ action: "create" | "update", agent?: "<slug, update only>", draft: {…AgentDraftCreate or AgentDraftUpdate} })
```
Registrar: `POST /api/agents/change` with `{sessionID, messageID, callID, action, agent, draft}`. Replies (sentences):
- applied create: `Created <Name> (@<slug>). It is ready: you can hand work to @<slug> now. The user sees a card with Undo.`
- applied update: `Updated <Name> (@<slug>). The user sees the change on a card with Undo.`
- pending: `Proposed. The user sees a card to <create it|apply it>; nothing is written until they click. Tell them in one
  line and stop; don't claim it is done.`
- refused: `Not changed: <sentence>`.
Added to the plugin inventory test (`scripts/opencode-v2/plugin-pack.test.mjs`).

### 2.4 Server — `src/server/agents.mjs`

**Caller binding.** Generalize `verifyInvocation` to take the tool name and a per-tool comparison: `agent_handoff` keeps
its existing comparison exactly (absent `continueJob` ≡ ""); `agent_change` compares the running part's input to the
request with exact field presence (`action`, `agent`, nested `draft`; omitted ≠ null). Consume `messageID+callID` once
(the existing `consumed` map). Then require a valid lead and `classify(sessionID, lead).kind === "led"`; `unknown` →
"Couldn't check this chat; try again"; a missing caller mode or plan mode → "Not in plan mode". Not led → "Only the lead
can create or change agents". (The tool is registered globally like every plugin tool; the server refuses it outside a
led chat.)

**Policy.** `decide("agent_change", policy)`; unreadable → `SETTINGS_UNREADABLE`; never → "Changing agents is turned
off in your autonomy settings". `needsClick` = level `ask`, OR the target is the lead (`reason:"lead"`), OR an update
moves `isolation` none→worktree (`reason:"isolation"`).

**Building `after`.**
- Create: frontmatter `name, description, isolation, use_when?, not_for?, model?, color?` + body = instructions.
- Update: resolve the target ONLY from the validated scan entries (never a path built from the request); refuse a
  symlinked `agent.md` or folder. Edit the existing file with the `yaml` Document API, setting/deleting only the touched
  keys so unknown keys and comments survive; replace the body only when `instructions` is given. If the file can't be
  parsed as a Document, refuse ("Dev's file can't be edited safely; fix it by hand").
- `after` must parse with `parseAgentMd` to the intended fields (else refuse).

**One operation lock.** Every operation on a record (`change`'s immediate write, `apply`, `discard`, `undo`, retry) runs
inside ONE `syncLock.runExclusive`, from a FRESH read of the record through the policy check, the file work, `syncLocked`
and the final record write; it publishes only after the record is persisted. (The store's own `createMutex` only guards
the JSON file inside that.) So Apply/Apply, Apply/Discard and Undo/Undo can never both act.

**Re-checking the target at mutation time.** A first create (no slug yet) only checks that the agents root is a real
directory and claims its slug by exclusive `mkdir` (test: Ask → Create from an empty target). Update, retry and undo,
under the lock and before changing anything, re-resolve the slug from a fresh scan and require: the agent folder and `agent.md` are real (not symlinks), the folder still lives
directly under the agents root, and (create-undo) `.compiled.md` is a regular file. Anything else → `conflict` with no
write or removal.

**Writer (private).** Split `sync()` into `syncLocked()` (the body) and `sync()` (`syncLock.runExclusive(syncLocked)`).
`writeChangeLocked(record)` (called with the lock held):
- Create: claim a slug by exclusive `mkdir` (existing loop) unless the record already has `slug` (a retry after a sync
  failure reuses it); write `agent.md` (temp + rename), make `home/`; persist `slug` on the record BEFORE `syncLocked()`.
- Update: re-read the target's raw bytes; must equal `before`, else state `conflict`
  ("<Name> changed since this was proposed; ask Manta again"); write `after` (temp + rename).
- Then `syncLocked()` and the config reload it triggers. A failure there → state `failed` ("<Name> was written but
  couldn't be activated: <why>"), the file stays.
- **Retry** (`apply` on a `failed` record): re-check the target (above) and that its bytes still equal `after`
  (else `conflict`); never rewrite or reclaim; force the activation again (`syncLocked({ forceReload: true })` — the
  config reload runs even when the files didn't change).
The `agents:create` RPC is unchanged (name/description/isolation only) and does not use this writer.

**Store.** `~/.manta/agents/.changes.json` via `writeJsonAtomic` (`src/server/jsonStore.mjs`), its own `createMutex()`
for read-modify-write; ≤ 200 records, terminal ones pruned after 7 days; pending ones become `expired` after 24 h
(checked at read and at click). Bounded and single-process, so a JSON file like `schedule.json` fits.

**Operations** (each persists, then publishes `agentChange`):
- `change(input)` → record; not `needsClick` → `writeChangeLocked` now (state `applied` / `failed` / `conflict`).
- `apply(id)`: pending (not expired) → re-read policy (unreadable → error, `never` → refuse) → `writeChangeLocked` →
  `applied`; failed → Retry (above). Any other state → returned unchanged (a second click is a no-op).
- `discard(id)`: pending → `discarded`.
- `undo(id)`: applied →
  - update: current bytes must equal `after` (else `conflict`); write `before`; `syncLocked()`; `undone`.
  - create: the folder may contain only `agent.md` (bytes equal `after`), the generated `.compiled.md`, and an empty
    `home/` (no other file, no non-empty dir); remove exactly those files and dirs (never recursive delete), then
    `syncLocked()` (which removes the installed agent config). Otherwise refuse "It has been used since; delete it by
    hand". No job-record check: "unused" means "its folder is untouched".
  Both inside one `syncLock.runExclusive`.
- `forCall({sessionID, messageID, callID})` → the record or null.
The agents engine gets an injected `publish` (wired in `index.mjs` to `bus.publish`).

## 3. Lead brief

`buildLeadBrief` MECHANICS gains (byte-stable):
```
- To create an agent or change one (including yourself), call `agent_change` directly; don't ask first in words — the
  user approves on the card when their settings require it. Draft complete, specific instructions in the style of the
  existing agents (how it works, what it never does); make it read-only unless it must change code; leave the model empty
  (Auto) unless the user named one. Only say an agent exists once the tool says it was created.
```
`KIND_DEFINITIONS.agent_change` becomes: "change an agent = creating an agent or editing any agent's instructions,
model, tools or permissions, including your own." (shared table; the lead eval and Phase 3c tests updated.)

## 4. Renderer

- **Recognition (one predicate).** `isAgentChangePart(part)` = a tool part whose tool is `agent_change`, in any state.
  Used by `ToolCall.tsx` (renders `AgentChangeCard`) and `toolActivity.ts` (a run BOUNDARY, never folded into a
  collapsed activity group). The server has two grouping paths and BOTH get the same rule: `transcriptRuns.mjs`
  (history) and `streamInterp.mjs` / the run ledger (live). Order `read → card → read` holds live and after reload.
- **`AgentChangeCard`** (`src/renderer/AgentChangeCard.tsx`): subscribes to `onAgentChange` BEFORE its first fetch. While
  the part is running it shows "Preparing the change…" and accepts any event for its session as a hint to fetch;
  it fetches `agentsChangeFor({sessionID, messageID, callID})` when the part settles, on each hint, and on reconnect.
  - Header "New agent: <Name>" / "Change to <Name>" + state chip.
  - Create: description, use when / not for, "Edits code (own branch)" or "Read-only", model or "Auto", instructions in
    a native `<details>` (modern-web-guidance `html` / `search-hidden-content`).
  - Update: unified line diff of `before`/`after` (the `diff` package's `diffLines`), collapsed beyond 30 lines.
  - Reason line when `needsClick` for power: "This changes Manta's own instructions" / "This lets <Name> edit code".
  - Buttons: pending → **Create**/**Apply** + **Discard**; applied → **Undo**; failed → "Written, not activated" +
    **Retry** (= apply);
    others none. Each press awaits the call, disables the buttons meanwhile, and shows the outcome (new chip or the
    server's sentence). No record found (pruned, or the tool was refused) → "This change is no longer available" with
    no buttons (or the tool's refusal text when the part shows one).
- **Sidebar refresh.** `packageAgents.ts`'s cache subscribes to `onAgentChange` (independent of any card) and refetches
  `agents:list`; also on reconnect. So a click on one desktop updates every open desktop.

## 5. Security and honest limits

- Only the lead's verified, single-use live tool call creates a record; elsewhere the server refuses the tool, and
  specialists are also blocked from writing `~/.manta`. There is no model-facing apply/undo tool.
- "Needs a click" stops an agent acting on something it read. It is not a hard boundary: the `/rpc` apply channel takes
  the box credential, which the primary desktop and the box's own tools share, and Manta's chat has the user's shell.
  Device-bound approvals are a follow-up.
- The card shows the exact bytes that are written (`after`), built by the server.

## 6. Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Line diff on the card | `diff` 9.0.0 (already a dependency, BSD-3, published 2026-04) | react-diff-viewer 3.1.1: last release 2022-05, unmaintained; react-diff-viewer-continued 4.4.0 (maintained, MIT): a new dependency + its own styling for one small view; `diffLines` + our classes is ~30 lines |
| Frontmatter edit preserving comments/unknown keys | `yaml` 2.9 Document API (already a dependency) | gray-matter 4.0.3: last release 2023-07, re-serializes (loses comments) |
| Collapsible instructions | native `<details>` (modern-web-guidance `html`, `search-hidden-content`) | accordion libraries: native element is accessible and searchable |
| Store | JSON via `writeJsonAtomic` (`src/server/jsonStore.mjs`, as `schedule.mjs`) | SQLite: overkill for ≤ 200 records in one process |
| Mutex | `createMutex` (`src/server/jsonStore.mjs`) + the module's `syncLock` | async-mutex (installed): the repo already standardizes on its own helper |

## 7. Tests (heavy suites on Freestyle)

- `agents.test.mjs`: binding (non-lead, replay, changed nested field, specialist direct chat, managed child, unknown
  classification, plan mode); matrix (auto/tell apply, ask pending, never refused, lead always pending, none→worktree
  pending, new worktree agent follows level); field rules (unapproved model, catalogue down, lead model/isolation
  refused, reserved slug, bad color, multi-line); update preserves unknown keys/comments and pins; symlink refused;
  apply/discard/undo machine; simultaneous Apply/Apply and Apply/Discard; conflict on hand edit (auto and clicked);
  folder replaced (symlink) between proposal and click → conflict, nothing written/removed; activation failure → failed,
  retry re-activates without rewriting (rejected reload then success), hand edit between attempts → conflict; existing
  handoff verification unchanged (no `continueJob`); undo after a real sync removes `.compiled.md` and the config block; undo of a used folder refused; expiry at
  click time; stale click from another device; unreadable policy at apply; store cap; publish after each transition;
  `agents:create` unchanged.
- Plugin: tool sentences per outcome; inventory updated.
- E2E (pinned binary, extend `scripts/opencode-v2/handoff-visibility.e2e.mjs`): the running part exposes the nested
  `draft` so the binding check works.
- Renderer: card states/buttons/rpc outcomes, diff rendering, no-record state, running → no record → event → buttons
  without reload; `toolActivity` keeps the card outside collapsed groups; sidebar cache refetch on the event.
- Server: `transcriptRuns` and the live run ledger both end a group at `agent_change` (`read → card → read`).
- Lead eval: extend `scripts/agents/lead-eval.mjs` with an `agent_change` action and 4 cases ("make me a reviewer…",
  "change Dev to…", plus two that must NOT create an agent).

## 8. Implementation split

Committed first by the lead: this spec, the §2.1 types and channel/event declarations (`src/shared/types.ts`,
`src/shared/api.ts`), the `KIND_DEFINITIONS.agent_change` wording.
- Server (Sonnet 5.5 #1): `src/server/agents.mjs` (+test), `src/server/rpc.mjs`, `src/server/index.mjs`
  (`/api/agents/change`, publish wiring), `docs/opencode-plugins-v2/manta/tools/agents.ts` (+ plugin test, inventory),
  the e2e extension, `scripts/agents/lead-eval.mjs` + cases, the Phase 3c tests touched by the definition change,
  `src/server/transcriptRuns.mjs` and `src/server/streamInterp.mjs` / `runLedger.mjs` (run boundary).
- Renderer (Sonnet 5.5 #2): `AgentChangeCard.tsx` (+test), `ToolCall.tsx`, `toolActivity.ts` (+tests),
  `packageAgents.ts`, `api/httpApi.ts`.
