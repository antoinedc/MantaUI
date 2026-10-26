# Auto-handoff — design

Status: draft v2 (open questions resolved) · Branch: `feat/auto-handoff`
Target runtime: opencode **V2** (box verified on 2.0.30, main already on V2).

## Problem

When a chat session gets long, the user manually asks "give me a handoff prompt
to keep going in a fresh session", clears, and pastes it. The only automatic
mechanisms today are opencode's own auto-compaction (fires mid-task on overflow
— the worst moment) and the optimizer's idle background compaction. Both
summarise in place: lossy, and they stack summary on summary.

## Evidence this design rests on

- **Context rot** (Chroma, 18 models): quality degrades with input length well
  before the window is full, on every model → trigger on an absolute budget.
- **Handoff beats compaction** (Amp removed compaction for handoff, Oct 2025):
  goal-directed extraction into a fresh thread, shown as an editable draft.
- **Structured > free-form** (Factory, 36k messages): fixed sections beat
  Anthropic/OpenAI compression; file-artifact recall is the weakest dimension
  for every method → the system records artifacts, not the model.
- **Durable state > summary** (Anthropic long-running harness): progress files,
  git and todos are what make a fresh context productive.
- **Tool-output clearing** is the cheapest lever (Anthropic context editing,
  opencode `compaction.prune`).

## Part A — enable tool-output pruning on every box (ships first, independent)

- opencode's `compaction.prune` defaults to off; V2 still honours it (verified in
  the 2.0.30 config schema). Set it on.
- **Rollout:** one-time migration run by the box updater BEFORE it restarts
  opencode (so it applies on that same update), and by the installer.
  - Surgical, comment-preserving edit of the opencode config file (same jsonc
    library the server already uses). Never a hand-rolled read/merge/write.
  - Writes `compaction.prune: true` **only if the key is absent**; an explicit
    user value (true or false) is left alone.
  - Records marker `migrations.pruneDefault` in the box state config so it runs
    once; a user who later turns pruning off is never re-overridden.
  - Never fatal: missing/unparseable config → warn, update continues.
- Dev box set by hand 2026-10-26 (takes effect at opencode's next restart); the
  migration must see the key present and only record the marker.

## Part B — the handoff engine

One server-owned engine, five entry points:

| Entry point | Who | Default outcome |
|---|---|---|
| `/handoff [goal]` in the composer | user | per mode (D) |
| "Hand off" in the context pill popover (desktop) / context meter sheet (iOS) | user | per mode |
| `handoff` tool, `action: "suggest"` | agent | always a suggestion card |
| `handoff` tool, `action: "handoff"` | agent | per mode |
| automatic trigger (Part C) | server | per mode |

### B1. Producing the handoff text

Two producers, same template and same appended facts:

1. **Agent-authored (tool path).** The agent passes the handoff body as the
   tool's argument (it holds the full context and the cache is warm — no extra
   model call). Optional `goal` argument.
2. **Server-generated (button, `/handoff`, automatic).** Uses opencode V2's
   session-scoped one-shot generation — `POST /api/session/{id}/generate
   {prompt}` → `{data:{text}}`, the same call behind V2's built-in `/btw` side
   question. **Verified live on the box:** it answers from the session's full
   history (recalled a codeword from an earlier turn) and adds **no** message to
   the session (message count unchanged). It runs on the session's own model and
   prefix, so the prompt cache stays warm. Run it only when the session is idle
   (shared busy gate).

Template (both producers), markdown:
`## Goal · ## Current state · ## Decisions (and why) · ## Dead ends tried ·
## Next step · ## Open questions`. A user `goal` steers it ("hand off to:
<goal>").

### B2. System-recorded facts (appended by the server, never model-written)

`## Context from the previous session`:
- previous session id + title, and a line telling the agent it may read that
  transcript on demand rather than assume;
- files edited in the session (from the session's tool parts);
- branch + uncommitted-change summary of the session directory;
- the todo list as of now;
- the last test/build command run and its pass/fail;
- the stored standing instructions (reuse the optimizer's constraint store; run
  extraction first if none stored).

Assembly is a pure function (session data in → markdown out), unit-tested.

### B3. The suggestion card (dedicated block)

Whenever a handoff is a *suggestion* rather than an automatic switch, the
transcript shows a **dedicated handoff block**, distinct from normal assistant
text:
- Header: "Handoff prompt" + why it was produced (agent / you / context budget
  at N tokens).
- Body: the full prompt rendered as markdown (collapsed after ~12 lines with
  "Show all").
- Three buttons:
  1. **Copy** — copies the raw **markdown** source (not rendered text).
  2. **Clear & start** — replaces this session in the same window with a fresh
     one, sends the prompt; the old session is hidden (Part E).
  3. **Start in new session** — creates **another** chat session in the same
     project (new window, same directory), with the **same model settings** as
     the current session (provider + model, reasoning effort / variant, fast
     toggle, agent), sends the prompt and switches to it. The current session
     stays where it is, visible and untouched.
- The user can edit the prompt before starting (an "Edit" affordance that
  drops it into the target composer instead of sending). Not a separate button
  row item on mobile — long-press / secondary action.
- After either start button succeeds, the card shows "Started in <session>"
  with a link, and its start buttons disable (idempotent: one start per card).

**Carrier (so the card survives reloads and renders on every client):**
- Agent path: the `handoff` tool part itself. Clients render tool parts named
  `handoff` with this block. The tool output is the final markdown (agent body +
  B2 facts), so the card is fully reconstructable from the transcript.
- Server-generated path in suggest mode: the server stores the handoff record
  (B5) and publishes a bus event; clients render the card pinned above the
  composer (same place as other session cards), fetched from the record on
  load. It is **not** injected into the session's model context.

### B4. Executing a start

`Clear & start` and auto mode reuse the existing clear path (fresh session in
the same window, cwd + model override carried). `Start in new session` reuses
the existing new-window path (chat-mode window in the same tmux session /
project). In both: send the prompt as the new session's first turn with the
model settings supplied by the caller. Model settings are client-side state
today (per-session on desktop and iOS), so **the caller passes them in the
request**, and the bus event carries them so every client persists them for the
new session id.

### B5. Persistence

Server store (`~/.manta/handoffs.json`, atomic writes, via `statePath`):
handoff records `{id, fromSessionId, toSessionId?, kind: suggest|auto,
trigger, text, createdAt, startedAt?, startedHow?}` and session linkage
`{sessionId → predecessorId, hidden}`. Bounded retention (e.g. 200 records /
30 days); linkage for live sessions is never pruned.

## Part C — when it fires automatically

Fire when **all** hold:
- **Natural boundary:** a turn has just completed (session idle) AND one of:
  every todo is terminal; a commit landed in the last turn; or the agent called
  the tool (`action: "handoff"`).
- **Over budget:** context tokens > working budget.
- Not handed off within a cooldown (30 min); no handoff already in flight;
  session not busy; mode ≠ off.
- If the user has typed into the composer (unsent draft), do not auto-switch —
  degrade to a suggestion card.

**Working budget** = min(family ceiling, 60% of the model's context window).
One table, defaults: frontier (Opus, Sonnet, GPT-6 class) ≈ 200k; smaller /
cheaper ≈ 100k; unknown model → 60% of window. No user setting.

**Agent awareness (resolved):** the existing Manta optimizer plugin already runs
on opencode V2's per-request `context` hook and already fetches a per-session
policy from manta-server. Extend that policy with `{contextTokens, budget}`;
when usage crosses 70% of the budget the plugin appends a short note **at the
tail of the request** (not the system prompt — a system edit would invalidate
the prompt cache every turn): "Context: 148k of a 200k working budget. At your
next natural stopping point, call `handoff`." Fail-open like the rest of the
plugin. Also instruct the `handoff` tool description to prefer `suggest` when
unsure whether the user wants to continue here.

**Backstop:** opencode auto-compaction stays on as the overflow safety net. When
mode ≠ off, the optimizer's idle background compaction hands off instead of
compacting (one owner per session — never both).

## Part D — mode control

- Box config `handoffMode`: `auto` (default) · `suggest` · `off`.
  - `auto`: fresh session in the same window, prompt sent, old session hidden.
    A one-line notice tops the new session ("Continued from <title> — handed off
    at 182k tokens · View previous") and an entry goes on the optimizer activity
    log.
  - `suggest`: a suggestion card (B3) appears; nothing switches until the user
    presses a button.
  - `off`: no automatic trigger; manual `/handoff`, the button, and the agent's
    `suggest` still produce cards.
  - The agent's `action: "suggest"` always yields a card, in every mode.
- **Desktop:** control next to "Bypassing permissions" in the composer; click
  cycles auto → suggest → off; label shows the mode ("Handoff: auto").
- **iOS:** in the chat overflow sheet, directly under the existing "Trust mode"
  toggle, as a three-way segmented control. Same config key over `config:update`.

## Part E — old sessions

- After `Clear & start` or an auto handoff, the old session is **hidden** from
  the sidebar (desktop) and session list (iOS). Not deleted.
- Reachable from the session "…" menu (desktop: top right; iOS: chat overflow
  sheet) as **Previous sessions** — the predecessor chain, newest first. Opening
  one shows it read-only in the same pane with a "Back to current" bar.
- `Start in new session` hides nothing.

## Part F — iOS scope (in this feature, not a follow-up)

Every user-visible piece ships on iOS or is absent there (no dead controls):
1. Render the handoff block (B3) for `handoff` tool parts and pinned suggestion
   cards, with Copy (markdown to `UIPasteboard`), Clear & start, Start in new
   session.
2. Mode control in the overflow sheet (Part D).
3. "Previous sessions" in the overflow sheet, read-only predecessor view.
4. Auto-handoff notice at the top of the continued session.
5. Honour the `handoff` bus event: switch the open chat to the new session id,
   carry model prefs, drop the old session from the list.
6. `/handoff` typed in the composer works (it is just a command to the server).
7. "Hand off" action in the context meter's detail sheet (if the meter has no
   sheet today, put it in the overflow sheet instead).

iOS changes are verified per `mobile/native/AGENTS.md` (no Swift toolchain on
the Linux box — build via the Mac worker / CI).

## Contracts to pin before parallel implementation

- `POST /api/handoff` `{sessionId, action: "suggest"|"start", how?:
  "clear"|"new-session", goal?, text?, cardId?, model?: {providerID, modelID,
  variant?, fast?, agent?}, trigger: "user"|"button"|"agent"|"auto"}` →
  `{handoffId, text, toSessionId?, window?}`. Errors (400-class, readable):
  `busy`, `already_in_flight`, `already_started`, `generation_failed`,
  `not_found`.
- `GET /api/handoff?sessionId=` → pending suggestion cards + predecessor chain.
- `POST /api/handoff/:id/start` `{how, model}` (card buttons) — idempotent on
  `already_started`.
- Bus event `handoff` `{handoffId, fromSessionId, toSessionId?, kind, trigger,
  how?, model?}`.
- Agent tool `handoff` `{action: "suggest"|"handoff", goal?, body}` — global
  opencode tool, thin registrar to the endpoint, returns the final markdown.
- Config keys: `handoffMode`, `migrations.pruneDefault`.
- Rendering rule: a tool part named `handoff` renders as the handoff block on
  desktop and iOS.

## Resolved questions (2026-10-26)

1. **Can the agent be told its usage on V2?** Yes — V2 plugins get a
   per-request `context` hook (the optimizer plugin already uses it; built-in
   plugins use it to edit tools/system). Note goes at the request tail.
2. **Hidden generation?** Yes — `POST /api/session/{id}/generate`, verified live
   (uses session history, adds no message). No fork/throwaway needed.
3. **V2 session API compatibility?** Verified live: create, prompt, active,
   message list, delete all 200/204; main already targets V2 for every path this
   feature uses. (The earlier "config writer 405" note applied only to a stale
   pre-V2 branch.)

## Remaining risks

- **Token accounting of `generate`:** unverified whether its usage lands in the
  ledger the optimizer/usage dial reads. Measure during implementation; if not,
  record it explicitly so plan-usage numbers stay honest.
- **Tool-path content quality:** the agent writes the body itself; the template
  is enforced by the tool description + a server check that all six headings
  exist (missing → server regenerates via `generate`).
- **Auto mode switching under the user:** mitigated by boundary-only firing,
  the unsent-draft rule, the visible notice, and Previous sessions.

## Verification

- Unit (pure): trigger decision (boundary × budget × cooldown × busy × mode ×
  draft), budget table, migration idempotency (absent → set; true/false →
  untouched; marker → skip), facts assembly, template check, card start
  idempotency.
- **Quality gate before `auto` ships as default:** probe-based eval (Factory
  method) over ≥30 past sessions from this box: at the same cut point produce a
  handoff and an opencode compaction; ask recall / files-changed / next-step /
  decision probes; judge-score. Handoff must match or beat compaction.
- Live (desktop + iOS): a session driven over budget hands off in auto, shows a
  card in suggest, does nothing automatic in off; agent `suggest` card with all
  three buttons; Start in new session keeps model settings; old session hidden
  and reachable via Previous sessions.
