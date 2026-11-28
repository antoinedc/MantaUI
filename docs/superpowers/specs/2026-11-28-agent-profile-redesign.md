# Agent profile redesign (profile v5) — build spec

Source of truth for looks and behaviour: `docs/screens/agents/profile-v5.html`; its decisions: `docs/screens/agents/profile-v5-decisions.md`.
This spec says how the code gets there. Decisions the user added on top of v5 (2026-11-28):

- **The model picker stays in the agent conversation.** It behaves like a normal session: it starts on the agent's own model
  setting (the existing default chain, see §6), and the user may override the model for that conversation.
- Open decisions of v5 stand as defaulted: the Team dot stays green until the conversation is opened; no agent badge on a Team
  row; Clear is kept, behind a confirmation.
- Out of scope, listed in `docs/agents/follow-ups.md`: (1) the agent starting tasks in a project from its own chat, (2) choosing
  the refresh day, (3) a learning setting per agent, (4) renaming the @handle.

A parallel job builds the Fleet redesign (`fleet-redesign`). It also edits `AgentsSection.tsx` and the `<AgentsSection>` line of
`Sidebar.tsx`; this job keeps its sidebar edit to ONE new component (`TeamSection`) mounted after the workspace list.

## 1. What exists and what is new

| Piece of the design | Today | This build |
|---|---|---|
| Header with Use it when / Not for above the tabs | Overview "How to use it" block + details pane | new header block (client) |
| Tabs Overview · Skills · Seats · Learned · History · Research · Settings | Overview · Research · Seats · History · Learned · Tests | client; Skills and Settings are new tabs, Tests merges into History |
| Instructions as formatted text + Sections index | a `<pre>` folded in the Overview, read from the history's last snapshot | client; the box now sends `profile.instructions` (the agent file's body) |
| History: applied changes only, one line each | every state, with cards | client |
| Settings fields that save | none (only Manta's tool changes an agent) | **new rpc `agents:settings-set`** through the existing change flow |
| Refresh on/off, day shown | on/off through `refreshSet` | client + `profile.refresh.day` (read-only; the day is `refreshDay(slug)`, already how the routine is made) |
| One conversation per agent | `agents:open-chat` (window in the hidden `manta-agents` tmux session) | unchanged; shown in a Team section |
| Clear conversation | none for agents (the generic `/clear` would drop the agent) | **new rpc `agents:clear-chat`** |
| Which window is which agent's | window NAME only (breaks on rename) | **new rpc `agents:chats`** (slug → session id) |

## 2. Server

### 2.1 `agents:settings-set` — `{ slug, field, value }`

`field` ∈ `name | description | useWhen | notFor | model | isolation` (the draft keys the change flow already knows; `isolation` is
"own branch" `worktree` vs "read-only" `none`). `value` is a string, or `null` to clear (`useWhen`, `notFor`, `model` = Auto; an
empty string means null for those, as in the existing draft check).

Result: `{ outcome: "saved" | "waiting" | "unchanged", change: AgentChange | null }`.
- `saved`: a change record was created and applied; `change` is its wire form (state `applied`).
- `waiting`: only for an isolation raise (read-only → own branch): the record is `pending` with `reason: "isolation"`, `needsClick: true`.
- `unchanged`: the value equals what the file has. No record.
Refusals are thrown `AgentError` sentences (HTTP 400 through `agentsCall`): unknown field, the handle ("can't be renamed yet"), an agent
that doesn't exist, a locked agent, a draft the existing validation refuses (length, one line, an unapproved model),
autonomy "Change an agent" = Never, an agent whose file can't be edited safely.

**Change-flow integration** (it is `restore`'s shape, not a second writer):
1. `requireChangeAllowed()` — the same refusal `restore` and `refresh` use when the user's "Change an agent" level is Never.
2. Under `syncLock`: `planChange({ action: "update", agent, draft: { [field]: value }, approved, via: "change" })` does all
   validation (`checkDraft`, `editAgentMd`, the lead's editable fields, `raisesIsolation`), then a `normalizeRecord` with
   `origin: { kind: "settings", field }`, `kind: "update"`, `summary` (one sentence naming field, old → new), `attachBundles`.
3. **A user's own save applies directly** (`applyLocked(rec, "click")`, the press IS the approval), at any "Change an agent" level
   that isn't Never — including Ask, which only makes an AGENT's change wait. Nothing about it goes to Needs you.
4. **An isolation raise follows what the change flow already does**: `planChange` reports `raisesIsolation`, and for every other
   caller (`change`, the Architect's `propose`) that makes the record wait for a click (`reason: "isolation"`). So the record is
   saved `pending`, `outcome: "waiting"`, and shows in Needs you with Apply / Discard like any raise; History never shows it until it
   is applied. The profile says so ("Waiting for your OK in Needs you"). Lowering isolation (own branch → read-only) applies directly.
5. A write failure marks the record discarded and rethrows, exactly like `restore`. `publishChange` + `fleetChanged` run after the lock.
6. **Locked agents.** The lead (Manta) and the Architect keep their wording, routing lines and isolation "via Manta": for them every
   field but `model` is refused (`<name> is built into Manta; <label> changes only through Manta`), and the lead's model is refused by
   `checkDraft(lead)` as today. The Architect's model is the user's to set here (no "core" click: `reason: "core"` guards an AGENT
   editing the Architect; the user's own save is the click).
7. **Undo** is the existing `agents:change-undo` on the record (`origin.kind: "settings"` is a plain update with bundles).

`AgentChangeOrigin` gains `{ kind: "settings"; field: string }`. `historyWho` reads it as "You · in Settings".

### 2.2 `agents:clear-chat` — `{ slug }` → `{ sessionId, windowIndex | null }`
Under the same `chatLock` as `openChat`: find the agent (not the Architect); create a NEW session exactly the way `openChat` does (the
agent's own key, its home folder; the lead on the default agent); write `.chat.json` (`CHAT_FILE`) to the new id; if a `manta-agents`
window carries the old session id, `tmux.restampSessionId` it to the new one, then `syncState.refreshNow()`. The old session is kept in
opencode (like the generic `/clear`). Learned preferences, project notes, seats and briefs are other stores and are untouched. The
renderer's generic `/clear` is not used for an agent: it creates a session with no agent key.

### 2.3 `agents:chats` → `Record<slug, sessionId>`
Reads each non-Architect agent's `.chat.json`. Cheap (one small file per agent) and read-only. The sidebar uses it to find the agent's
window by session id; the window's own tmux NAME is the agent's name when it was opened and is not trusted afterwards (Settings can rename).

### 2.4 `agents:profile` additions
`instructions: string` (the body of `agent.md`, "" when unreadable — for the Overview) and `refresh.day: number | null` (the day of
the month the refresh runs, `refreshDay(slug)`; null when the agent has no refresh). Both are additive.

## 3. Wire and types
`IPC.agentsSettingsSet / agentsClearChat / agentsChats` (`src/shared/types.ts`), `Api` methods (`src/shared/api.ts`), `httpApi.ts`, the
demo state (`api/demoAgents.ts`), `rpc.mjs` handlers via `agentsCall`. `AgentProfile` gains `instructions?` (optional: an older box
omits it) and `refresh.day?`.

## 4. Profile (client)
Files: `agents/AgentProfile.tsx` (shell, header, tabs), `agents/AgentOverview.tsx` (instructions + Sections index),
`agents/AgentSkillsTab.tsx` (the Skills tab, reusing `AgentSkills` rows), `agents/AgentSettings.tsx` (+ `settingsView.ts` pure logic),
`agents/AgentHistory.tsx` (compact rows), `agentsView.ts` (tabs, history helpers). Removed from the page: the side pane / `DetailsPane`,
the pending-change cards, "Change via Manta" and "Mention in a chat", the Tests tab (its trials move into History's expanded detail
for the change that was tested).

- **Header:** avatar, name, facts line (`@slug · role · works · model`), description, ONE `Chat` button (`openChat`; not for the
  Architect, whose line says "Works through Manta: ask in any chat"). Under it the "Use it when / Not for" block with the
  "Nothing written yet. Add it in Settings." empty copy (Architect and Manta: "…Change it through Manta").
- **Tabs** (order fixed): Overview, Skills, Seats, Learned, History, Research, Settings. The Architect has no Seats tab; the lead has
  no Learned tab (as today). Tab counts as in v5 (`Seats 2`, `Skills 1`, …). The tablist keeps the existing hand-written, guide-backed
  pattern (roving tabindex, arrows/Home/End).
- **Overview:** the instructions through the existing `MarkdownBody` (react-markdown, the app's own renderer). A first `# <Agent name>`
  line is dropped (the page already has the name). `MarkdownBody` gets one optional prop `headingIds` that turns on the `rehype-slug`
  plugin it already uses for the Explorer, so headings carry ids. The **Sections** index lists the `h2`s read from the DOM after render
  (the ids rehype-slug made), shown when there are ≥ 3 and the Overview is ≥ 760px wide (a `ResizeObserver`-free CSS container query,
  as in the mockup), `position: sticky`, with `aria-current` on the section in view (IntersectionObserver scroll-spy; see §9).
- **Skills:** rows as in v5 (name, description, provenance, size, source link) and the empty state "No skills yet. When a proven
  skill fits <name>'s job, the Architect proposes it; you'll find it in Needs you, then here."
- **History:** only `applied` records, newest first, one line (`date · what changed`); a native `<details>` row. Expanded: who made it
  and how it landed, "Tested before it went live · N of M cases passed" with each case (trial verdicts), the change (the existing
  card view of the diff), and Undo (newest live change) / "Restore the version before it" (not on Created / Installed).
  Pending, undone and refused records never appear. Footer line as in v5.
- **Seats / Research / Learned:** unchanged components, moved out of the two-column layout. Access appears only in Seats.
- **Settings:** §5.

## 5. Settings tab
Group "Identity" (Name, Handle, Description), "When to use it" (Use it when, Not for), "How it works" (Model, Works, Refresh,
Learning). Fields are real `<input>` / `<textarea>` / `<select>` / radio buttons with a `<label for>`.
- **Editable (save on blur / change):** Name (≤ 40), Description (≤ 200), Use it when / Not for (≤ 200, optional), Model (Auto or one
  of the approved models: the options come from `agentsModels`-style list already used by the model picker, `opencodeModels`), Works
  (own branch vs read-only; a segmented radio group, saves on click).
- **Read-only:** the @handle (copy: "Renaming it isn't available yet"), the refresh day ("Next: 1 Dec" style line from
  `refresh.day`), Learning (shows the team-wide `learn_preference` level with a link to Settings → Agents, which opens the existing
  Settings screen on that tab).
- **Refresh:** a two-state radio (Monthly / Off) through the existing `agentsRefreshSet`, specialists only (as today).
- **Per-field state line** (`role="status"`, `aria-live="polite"`), never empty-then-silent:
  - unchanged → nothing is sent, no message;
  - saving → "Saving…";
  - saved → "Saved · added to History" + **Undo** (calls `agents:change-undo`, then "Undone · back to the previous value"; a refused
    Undo shows its sentence and a Try again); the profile and history are re-read;
  - waiting (isolation raise) → "Waiting for your OK in Needs you";
  - error → the box's sentence and **Try again**; the user's text stays in the field (the field is uncontrolled while editing and is
    only reset from the profile when it is not focused and not dirty).
- **Architect and Manta:** every wording field is read-only with the note "<name> is built into Manta, so its name, handle, wording and
  how it works change only through Manta: ask in any chat. Those changes always wait for your click." The Architect's model remains a
  select (it saves through the same channel); Manta's model is read-only too.

## 6. Agent conversation
Mounting: the existing `ChatPanel` for the window in the `manta-agents` tmux session. A small hook `useAgentConversation(sessionId, tmux)`
(reads `agents:chats` + `packageAgents`) says which agent the session is (`{ slug, name }` or null); everything below is behind it, so
no other session changes.

- **Model:** `modelOverride`'s initial state already falls back to `AppConfig.defaultModel`; for an agent conversation that fallback is
  the AGENT's own model (`agent.model`, from the package list) when it has one, else the default chain as for any session. The picker is
  the normal one; a pick is stored per session like any other (`manta:chat:<id>:model`). Clear carries the pick across as `/clear` does.
  (The conversation's session is created with the agent's own key, so a send with no override already runs on its model.)
- **SessionHeader** (`agentConversation` prop): crumb "Team / <Name>"; no branch chip or forge items; no Explorer toggle; no Hand off;
  the context pill and the Artifacts toggle stay; a **Profile** ghost button; the ⋯ menu holds only "Summarize earlier messages now"
  (the existing compact, `compactSession`) and "Clear conversation…" (the existing confirm dialog with agent copy: "Starts a new
  conversation with <Name>. What it learned from your corrections and each project's notes are kept." → `agents:clear-chat`; after it
  the store refreshes, the window now carries the new session, the panel remounts on it). Fork, Delete, Mode/Move are not offered.
- **InputArea** (`agentChat` prop): no plan chip (and ⇧Tab does nothing), no trust row, no schedules / secrets / webhooks toolbar. The
  model picker, mic, attach, usage dial, optimizer pill, `@` / `/` typeahead and Send / Stop stay.
- **ChatPanel:** `hasExplorer` is false (no Explorer panel, no ⌘E target); path clicks fall through to the preview overlay as for a
  terminal; no handoff controls. Clear while the agent is running is refused with a sentence in the dialog ("Stop <Name> first").
- Not built here (follow-up 1): task cards from the agent's chat and the agent picking a project.

## 7. Sidebar Team section
A "Team" block mounted once in `Sidebar.tsx` after the workspace list (away from the lines the Fleet job edits). The pure logic
(`teamView.ts`: which agents get a row, which window is whose) and the data hook (`useTeamRows.ts`: agent list + `agents:chats`, re-read
when the set of `manta-agents` windows changes) are their own files; the row itself, `TeamRow`, lives in `Sidebar.tsx` beside
`WindowRow` because it needs the file-private `dotFor` and `useAge` (one copy of the dot rules, no export cycle). One
`RailSessionRow` per valid agent except the Architect (the lead first, as in the Agents list): dot from the window's live status through
`dotFor`, name = the agent's name, age via `useAge`. Selected = the active window is that agent's. Click = the window if the agent
already has one, else `agents:open-chat` then select the window (a failure is a toast, never silent). Green stays until the
conversation is opened (the existing `attention` behaviour of a chat window); no badge. The `manta-agents` project stays hidden from
the workspace list (a Team row, or the profile's Chat button, is the way in).

## 8. Tests (failing first)
Server (node:test, `--import ./scripts/testSandbox.mjs`): `agentsSettings.test.mjs` — a name/description/useWhen/model/isolation save
creates an `applied` record with origin settings and the new file text; `useWhen: ""` clears; unchanged → no record; Undo restores the
file; unknown field / handle refused; locked agents refused except the Architect's model; Never refuses; Ask still applies directly;
an isolation raise leaves a `pending` record with reason isolation and the file untouched; an invalid/unapproved model is refused with the
existing sentence and creates no record; `agentsChat.test.mjs` for `clearChat` + `chats` + `profile.instructions/day`. `rpc.test.mjs` for
the three channels. Renderer (vitest): `settingsView` helpers, `AgentSettings` states (saved/error/unchanged/waiting/locked),
`AgentHistory` (applied only, one line, details), `AgentProfile` (tabs order, header, no pending card, one Chat button, Architect has no
Seats), `AgentOverview` (markdown, Sections index threshold), `TeamSection` (rows, dots, click paths), `SessionHeader` / `InputArea`
(agent variants hide exactly the listed controls and keep the model picker), `ChatPanel` clear path through `agentsClearChat`.

## 9. Modern Web Guidance (guides retrieved: `tabs`, `scrollspy`, `forms`, `validate-input-after-interaction`, `accessible-error-announcement`, `dialog`)
- `tabs`: the existing tablist pattern is kept (roving tabindex, selection follows focus, `hidden` panels). `focusgroup` is not
  available in the bundled Chromium.
- `scrollspy`: `scroll-target-group` / `:target-current` is Limited availability (Chrome 140+); this app's Electron 31 is Chromium 126, so
  the guide's own fallback, `IntersectionObserver` with `rootMargin: -50% 0 -50% 0`, is the implementation, mirrored into
  `aria-current`. Sections get `tabindex="-1"` targets via the heading ids; the scroller is the page's existing scroll region.
- `forms` / `validate-input-after-interaction`: real labelled controls, native `maxlength`; validate and save on `blur` only when the value
  changed, clear errors on `input`, status messages in an `aria-live="polite"` region (`accessible-error-announcement`); no save on every
  keystroke; the control is never disabled during a save so the user's text is never lost.
- `dialog`: the Clear confirmation reuses the app's `ConfirmModal` (a real modal with focus trap and Esc), not a new overlay.
- `details`/disclosure (`html` guide): History rows are native `<details>`, as the mockup and the existing component.

## 10. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Markdown rendering of the instructions | `react-markdown` 10.1.0 (already used; MIT; 56.1M downloads/week; last release 2025-03) via the existing `MarkdownBody` | a second renderer — no reason, the app has one |
| Heading ids for the Sections index | `rehype-slug` 6 (already a dependency, used by the Explorer) turned on by a `headingIds` prop; ids read from the DOM | `github-slugger` 2.0.0 (27.5M/wk) directly — would duplicate what rehype-slug already does and could drift from the ids it emits |
| Scroll-spy | native `IntersectionObserver` (the `scrollspy` guide's fallback; ~15 lines) | `react-scrollspy` 3.4.3: 72k downloads/week, last published 2022-06, effectively unmaintained |
| Tabs | the existing guide-backed hand-written tablist (~15 lines of key handling) | `@radix-ui/react-tabs` 1.2.1 (MIT, 75.3M/wk, 2026-10): a new dependency + a second tab pattern for a tablist that already exists and is tested |
| Save-on-blur form state | plain controlled-until-blur inputs + one small pure helper (`settingsView.ts`) | `react-hook-form` 7.92.0 (MIT, 61.5M/wk, 2026-11): built for submit-and-validate forms; this is six independent autosaving fields, each with its own state line, so its form-level state would be fought rather than used |
| Confirmation dialog | existing `ConfirmModal` | a new `<dialog>` — the app's modal already does it |
| Change record, undo, history | existing change store, `planChange`, `applyLocked`, `undoChange` | none: this is the "use the existing flow" requirement |
| Rows / dots in the sidebar | existing `RailSessionRow` | none |
| Rows we write ourselves | the Team section, the settings state line, the sections index | each is a thin composition of the above; nothing maintained does "autosave status line" or "agent row" |
