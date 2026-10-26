# Auto-handoff — design

Status: draft · Branch: `feat/auto-handoff`

## Problem

When a chat session gets long, the user manually asks "give me a handoff prompt
to keep going in a fresh session", clears, and pastes it. Today the only
automatic mechanisms are opencode's own auto-compaction (fires mid-task on
overflow — the worst moment) and the optimizer's idle background compaction.
Both summarise in place, which is lossy and stacks summary on summary.

## Evidence this design rests on

- **Context rot** (Chroma, 18 models): quality degrades with input length well
  before the window is full, on every model. → trigger on an absolute budget,
  not "nearly full".
- **Handoff beats compaction** (Amp removed compaction for handoff, Oct 2025):
  goal-directed extraction into a fresh thread instead of a summary of
  everything.
- **Structured > free-form summaries** (Factory, 36k messages): fixed sections
  (intent / files / decisions / next steps) outscore Anthropic and OpenAI
  compression. Artifact recall (which files changed) is the weakest dimension
  for every method → the system records it, not the model.
- **Durable state > summary** (Anthropic long-running harness): progress files,
  git, todos are what make a fresh context productive.
- **Tool-output clearing** is the cheapest lever (Anthropic context editing,
  opencode `compaction.prune`).

## Scope

### Part A — enable tool-output pruning for every box (ships first, independent)

- opencode's `compaction.prune` defaults to off. Set it on.
- **Rollout:** a one-time migration run by the box updater, BEFORE it restarts
  opencode (so it takes effect on that same update) and on fresh install.
  - Edits the opencode config file surgically (comment-preserving jsonc edit,
    same library the server already uses for removals). Never a hand-rolled
    read/merge/write.
  - Writes `compaction.prune: true` **only if the key is absent**. An explicit
    user value (true or false) is left alone.
  - Records a marker (`migrations.pruneDefault` in the box's state config) so it
    runs once. A user who later turns pruning off is never re-overridden.
  - Never fatal: a missing/unparseable config logs a warning and the update
    continues (same rule as the other updater steps).
- The dev box has already been set by hand (2026-10-26); the migration must see
  the key present and only record the marker.

### Part B — the handoff action

Three entry points, one engine:
1. `/handoff [goal]` typed in the composer.
2. A "Hand off" button in the context pill popover.
3. A `handoff` tool the agent can call itself (global opencode tool, same thin
   registrar pattern as the other Manta tools).

Engine steps (server-owned):
1. **Generate the handoff in the current session, right after a turn ends**,
   on the current model — cache is warm, so re-reading history is cheap, and
   the model holds the intent. Generated from a fixed template:
   `Goal · Current state · Decisions (and why) · Dead ends tried · Next step ·
   Open questions`. The optional user goal steers it.
   - The generation turn must NOT appear as a visible turn in the old
     session's transcript (or must be clearly labelled as the handoff).
2. **Append system-recorded facts** (not model-written): files edited in the
   session (from tool parts), branch + uncommitted-change summary, the todo
   list, the last test/build command and its result, the stored standing
   instructions (reuse the optimizer's constraint extraction store).
3. **Create the fresh session in the same window** via the existing clear path
   (inherits cwd, carries the model override forward).
4. **Link** the new session to the old one: the prompt names the previous
   session id and tells the agent it can look things up there on demand
   (existing transcript read tooling) rather than carrying it.
5. Mode-dependent finish (Part D): send the prompt, or leave it as an editable
   draft in the composer.

### Part C — when it fires automatically

Fire when **all** hold:
- **At a natural boundary:** a turn has just completed (session idle), AND one
  of: every todo is terminal, a commit landed during the last turn, or (agent
  tool path) the agent judged the task finished.
- **Over budget:** context tokens > the session's working budget.
- Not already handed off within a cooldown; session not busy (shared busy gate).

**Working budget** = min(family ceiling, 60% of the model's context window).
- Family ceilings live in ONE table with defaults: frontier models (Opus,
  Sonnet, GPT-6 class) ≈ 200k; smaller/cheaper models ≈ 100k. Unknown → 60% of
  window. No user setting.
- Rationale: quality tracks absolute tokens, not % full; cost per turn grows
  with context too.

**Agent awareness:** when context crosses ~70% of the budget, the agent gets a
one-line note of its usage and the instruction to call `handoff` at its next
natural stopping point. **Open question:** confirm the existing Manta opencode
plugin can inject this under opencode v2 (hook surface changed in v2).

**Backstop:** opencode auto-compaction stays on as the overflow safety net. When
handoff mode ≠ off, the optimizer's idle background compaction hands off
instead of compacting (one owner per session — never both).

### Part D — mode control and old sessions

- **Mode:** `auto` (default) · `suggest` · `off`, per box config.
  - `auto`: new session is created and the prompt is sent.
  - `suggest`: new session is created with the prompt as an editable draft.
  - `off`: no automatic trigger; manual `/handoff` and the button still work
    (as suggest).
- **Control:** sits next to the "Bypassing permissions" toggle, click cycles
  auto → suggest → off, label states the current mode. Must work on the native
  iOS client too or be absent there (no dead control).
- **Old sessions are hidden** from the sidebar after a handoff. They are
  reachable from the session "…" menu (top right) as "Previous sessions" —
  newest first, opens read-only in the same pane.
- Every automatic handoff is visible: a one-line notice at the top of the new
  session ("Continued from <title> — handed off at 182k tokens") and an entry on
  the optimizer activity log.

## Contracts to pin before parallel implementation

- Server endpoint for the handoff action (request: session id, optional goal,
  trigger source `user|button|agent|auto`; response: new session id, mode
  applied). Error codes: `busy`, `already_handing_off`, `generation_failed`.
- Bus event for the renderer: `handoff` with `{fromSessionId, toSessionId,
  mode, trigger}` so the pane swaps and the sidebar hides the old session.
- Session linkage persisted server-side (old → new, new → old) so the "…" menu
  can list predecessors after restarts.
- Config keys: `handoffMode`, migration marker `migrations.pruneDefault`.

## Dependencies / risks

- **opencode v2 on the dev box (2.0.30):** `PATCH /global/config` now returns
  405 (config moved to an authenticated endpoint). Manta's config writer is
  broken there; Part A deliberately does not depend on it. Session create /
  prompt / message-read used by Part B must be re-verified against v2.
- Hidden generation turn: if opencode can't run a turn without persisting it,
  fall back to a throwaway forked session for generation (warm-cache benefit
  partially kept — fork shares the prefix).
- Quality regression risk in `auto` mode → gated by the eval below.

## Verification

- Unit (pure): trigger decision (boundary × budget × cooldown × busy × mode),
  budget table, migration idempotency (absent → set; present true/false →
  untouched; marker → skip), system-facts assembly.
- **Quality eval before `auto` ships as default:** probe-based (Factory method)
  over ≥30 past sessions from this box: generate a handoff and, separately, an
  opencode compaction at the same point; ask recall / files-changed /
  next-step / decision probes; judge-score both. Handoff must match or beat
  compaction.
- Live: one real session driven over budget hands off in auto, suggest and off
  modes; old session hidden and reachable from "…".
