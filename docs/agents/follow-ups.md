# Agents — follow-ups

Open items deferred from the Agents phases. Each is decided (design + spec) when it is picked up.

## Changing autonomy from the chat (instead of Settings → Agents)

Today, when an action is set to Ask or Never, Manta tells the user to change it in Settings → Agents. Users would rather
do it from the conversation. Constraint: an agent must never raise its own autonomy (anything it reads could ask it to),
so the agent may only PROPOSE; the change needs the user's own click.

Direction discussed (2026-11-23), not decided:
- A tool lets Manta raise an app-drawn card in the chat ("Deploy is set to Never. Allow this once / Change to Ask /
  Change to Auto / Keep"); only the user's click applies it.
- "Allow this once" = that action, in that chat, for that turn; settings unchanged.
- Making a setting STRICTER could apply directly (it only restricts).
- Background tasks unchanged: they stop and report; Manta raises the card when it brings the result.
- Open decision: does "Allow this once" exist for Never too, or only for Ask (Never stays a hard wall, lifting it means
  changing the setting)?

### Refinement (user, 2026-11-23): an explicit request needs no card

- The card is only for a block the user didn't ask about: "build this and deploy" when deploy is Never/Ask (the user may
  not know the setting exists) — Manta offers the card.
- When the user explicitly asks to change a permission ("let agents deploy on their own for this project"), Manta applies
  it directly and confirms in one line (with undo) — asking again on a card makes no sense.
- Safety: Manta must not be able to do this because a file or web page asked. Idea: the change tool applies directly only
  when the request quotes the user's own latest message (the box knows which messages the user typed) and that message
  is about changing a permission; anything else falls back to the card.

## Per-project autonomy settings

Today one set of settings (mode + overrides) applies to every project. Wanted: e.g. agents may deploy plugin-builder on
their own but not ronda.
- Layers: box settings, then the project's overrides (last wins). A chat outside any project uses the box settings.
- Rules are already computed per task/chat at start, and projects have a stable identity (knowledge registry).
- Changed from the chat as above ("let agents deploy this project on their own"), with the same card/explicit split.

## Settings changes should apply to open chats right away

Today a change to the autonomy settings only reaches NEW chats: the lead's instructions are built when a chat starts.
Wanted: the change applies to the current chats too (background tasks keep the rules they started with). Needs a way to
refresh a running chat's instructions without breaking its prompt cache more than necessary (e.g. a short "your
settings changed: …" note on the next turn instead of rebuilding the whole brief).

Seen live (2026-11-23, plugin-builder chat): after the settings were switched to Autonomous and OpenCode restarted, the
chat HAD the new rules but still refused to deploy, staying consistent with its own earlier "deploys are turned off"
replies, until the user insisted. Planned fix: on a settings change, each open led chat gets a one-time note on its next
turn ("your autonomy settings changed at HH:MM: deploy is now Tell me; what you said earlier about these limits is out
of date"), appended rather than rebuilding the brief (cheap for the prompt cache). Test: refuse → change setting → ask
again in the same chat → it acts.

## The result's action matcher doesn't understand quotes

Seen live: a Dev task that only edited code and ran tests was reported as "Done without asking: deploy — fly deploy".
The command matcher splits on `;`, `&&`, `|`, newlines without respecting quotes, so text inside a quoted string (e.g. a
test fixture) can read as a command. Fix: quote-aware splitting (a small shell tokenizer, e.g. shell-quote), and only
count a segment that actually starts a command.

## Handoff gaps (seen live in a ronda chat, 2026-11-23)

- **Silent read-only fallback.** When the chat's folder isn't a git project (e.g. a broken linked checkout), a writing
  agent like Dev is quietly switched to read-only. Neither Manta nor the user is told, so the task fails late. Fix: the
  handoff says so plainly, or refuses with the reason ("this folder isn't a git project, so Dev can't change files here").
- **No way to point a handoff at another folder.** A task only sees the chat's own folder; work Manta prepared in a
  separate checkout/worktree was unreachable. Fix: let a handoff name a target project/folder (checked to be a real
  project, never Manta's own folders).

## Other background model calls may still run on opencode's title writer

Found while fixing the project actions scan: a one-shot background model call that doesn't name an agent runs on
opencode's `title` agent, whose own instructions are "output ONLY a thread title". The scan got "Classifying deploy
commands in project scripts" back instead of its JSON, on every model. The scan now names an agent
(`general`, tools denied). The other background classes (capture, corrections, curator, digest, gatekeeper, triage…)
still use the default — check which of them need a real answer and give them the same treatment. Related: the router's
quality-first ordering put Opus 5.5 at the top of the "fast" band (its benchmark percentile just fits it); only the scan
asks for the cheapest model of its band.

## From Phase 3c (docs/superpowers/specs/2026-11-23-agents-phase3c-judgement-and-action-map.md)

- Show the project's "Actions in this project" commands in Manta's own (lead) instructions, not only in tasks.
- Real isolation for tasks (a separate Unix user and OpenCode server per task).
- Specialists filing notes to the knowledge base themselves (today they have no `knowledge_note` grant).
- Host-based rules ("any command containing api.netlify.com").
- Test the approval card path with trust mode off.

## From the "background tasks can't use secrets" fix (2026-11-24)

The fix itself lets a task USE the secret files it was handed (shared ones and its own session's folder). What is still
missing around it:

- **Ask for a missing secret in the chat.** When a task needs a secret that isn't stored, the user gets a card in the
  chat (name + why), adds it on the card, and the task resumes on its own. Today the task ends "needs a decision" and
  Manta has to send a new round.
- **Settings changes go through Manta.** A task that needs a Manta settings change says so; Manta asks the user, or does
  it itself when the autonomy rows allow. Tasks never touch settings directly.
- **Two new autonomy rows: "Change Manta itself" and "Let an agent edit code"** (default Ask, settable to Tell me /
  Auto). They replace the hard-coded always-click rules in `agent_change` (the `reason` "lead" / "isolation" in
  `src/server/agents.mjs`), so a fully automatic setup is possible.
- **New Manta tools need an OpenCode restart.** Plugin code only loads when OpenCode starts. Investigate live plugin
  reload, or route new tools through one generic server-routed tool.

## From the Architect quick round (PDF reading, GitHub skill search, 2026-11-24)

- **Existing boxes keep their old Architect.** *(Resolved by Architect v2 Stage 0, 2026-11-27: `upgradeBuiltIns()` runs at
  boot, merges the shipped template into the box's folder and records each upgrade as a change.)* `installBuiltIns` never
  overwrites an existing folder, so a box's `~/.manta/agents/architect` (agent.md and `skills/research/SKILL.md`) did not
  get new instructions by itself.
- **PDF text is raw pdf.js text.** Two-column papers can interleave columns, hyphenated line breaks split words, and
  tables flatten. A quote that spans a column or hyphen break won't match; the model has to quote a single-column span.
  Possible later: join hyphenated line endings before storing.
- **No page or text-size cap for PDFs** beyond the 10 MiB file cap and the 30 s extraction limit; a very large paper
  stores a very large source (the 200 MB store cap still applies).
- **PDFs served as `application/octet-stream`** (some sites do this) are still refused as "can't be read yet"; sniffing
  the `%PDF-` header would fix it but the transport picks the 10 MiB cap from the content type.
- **GitHub blob addresses with a branch name containing `/`** (`blob/feature/x/path`) convert wrongly; the model can use
  the raw address instead.
- **GitHub search is repositories only without a `GITHUB_TOKEN`** (GitHub refuses unauthenticated code search) and has
  a 10-searches-a-minute limit. Adding a `GITHUB_TOKEN` shared secret enables the SKILL.md code search.
- **Whole-skill adoption is deliberately not built.** If it is wanted later, it should always need the user's click and
  show every file; skills are read as evidence only today.
- **Outcome lines are written when the task ends.** A proposal that is clicked, undone or that expires later is not
  re-reported; Manta only knows the state at delivery. The lead brief tells it to trust only the `Outcome:` line.
- **A resumed Architect round** (`continueJob`) reports only the records of its own task; the earlier round's records
  were reported in its own result.
- **The Outcome line names no summary or reason text beyond a fixed phrase**; a long list of proposals gives one line
  each (at most 5 per task).
- **`agent_change` (Manta's own tool) still says "nothing is written until they click"** on its Proposed reply; it is
  only returned when the card waits, so it is right, but it does not mention the user's level.

## Research library — follow-ups (first version shipped 2026-11-24)

Spec: `docs/superpowers/specs/2026-11-24-research-library.md`. Not in the first version:

- **A public shared shelf-life file.** A file in the repo with researched shelf-life defaults per topic (days + why +
  the evidence), updated through PRs, so a new topic can start from a researched number instead of researching its own
  shelf life. Shelf lives only, never findings: shared findings could be poisoned, and a PR is the review gate for a
  number. Agents would read it through the server (never a topic table in code), and a topic still gets its own why.
- **A library viewer in the app.** Browse entries (topic, age, fresh/stale, shelf life and why, findings with links),
  purge or correct one, and see which agent saved what. Today the library is only readable by agents.
- **Semantic search.** `research_library_find` is text matching (MiniSearch: BM25, prefix, fuzzy). Embeddings would catch
  differently worded topics ("checkout friction" / "cart abandonment"); the research notes warn that semantic matching
  reuses answers that differ only in a number, date or negation, so it needs the same fresh/stale header and a guard.
- **Routines and an agent's own chat.** The guidance is added to task prompts (`@mention`, handoff); a routine's agent
  run and an agent's own chat window get neither the guidance nor the tool binding (the binding needs a running task).
  The monthly refresh planned for 5B is the natural first user.
- **Tasks that were already running or finished before this shipped** keep the rules they were created with, so they have
  no research tools until their next new task; a resumed old task is the same.
- **Duplicate topics.** Two differently worded topics are two entries; a merge/dedupe pass (or "similar topic" hint
  at save time) would keep the library tidy. Entries are capped at 500 (newest checked kept) with no per-agent quota.
- **Poisoning and quality.** Library text is data and every quote is checked, but nothing yet samples how often a reused
  entry turned out wrong. Log reuse vs. correction counts (the research notes recommend a sampled wrongness check, not only
  a hit rate).
- **Event-driven staleness.** Entries go stale by date only; a change-log feed (a core update, a platform release) could
  mark entries stale early.

## A specialist's question (the `question` tool) — follow-ups (shipped 2026-11-24)

Spec: `docs/superpowers/specs/2026-11-24-ask-user-tool.md` (the first version was a custom `ask_user` tool, replaced the same day).
Not in this version:

- **No question card.** The result card shows the server-written block as text; a card with the options as buttons (and the
  answer sent back to the task) is the natural next step.
- **No recommended / why / concern fields.** The standard tool has none, so a recommendation lives in the question text.
  Parsing it out (or a structured convention in the text) would let the lead put the recommended option first without reading prose.
- **The question's header and the "type your own answer" flag are dropped.** The block lists the options only.
- **Built-in agents on existing boxes keep their old files.** Templates are copied once, so the Architect and Manta files of
  a box that already has them keep the old wording until the planned built-in self-update; the lead brief text, the task
  guidance and the rulesets arrive with the server release.
- **Tasks created before this release keep their `question` deny**, so they can't ask; a resumed one gets the new rules.
- **A question that was already pending across a restart is rejected, not captured.** The reconstruction and the sweep reject
  any ask they find pending in a job's sessions; capturing needs the form, which they don't read.
- **A subagent's question is still denied**, so a task whose subagent needs a decision gets a rejection, not a card.
- **A task that asked after it proposed.** An Architect that asks after `agent_propose` ends "needs a decision", so its
  proposals wait (reason: the task didn't finish cleanly) until the continued round finishes.
- **Only the lead continues the task.** The answer goes back via `continueJob`, so it needs the lead's own chat; a task
  started another way can't usefully ask. A question nobody answers stays on the finished task.
- **One decision per task round.** A second question in the same round replaces the first; a task that needs several decisions
  should put them in one question call (a form holds several questions) or ask across rounds.
- **The interrupt can cut the last message short.** If the model had started writing after calling the tool, that partial text
  is the task's result before the block. If the interrupt itself fails, the task ends when its own turn does (the stored decision
  still decides the outcome).

## Routing notes (an agent's routing line mentions an agent that doesn't exist) — follow-ups (2026-11-25)

What exists: on every read, the server scans each valid agent's `use_when`, `not_for` and description for `@slug` mentions
that name no folder in the agents directory, and writes one fixed line per finding ("Routing note: @a's not_for mentions
@b, which doesn't exist."). It goes into the lead brief (team section) and into the Architect task's team data. Nothing is
edited. Because it is computed from the folders on each read, it follows create, update, undo and a hand-made delete without
hooks into those paths.

Edge cases and not-yet:
- **An open chat sees a new note only after a new chat or a compaction.** The lead brief is cached per chat, so undoing an
  agent in a chat does not show Manta the resulting note until then (same limit as any roster change). Fix idea: drop the
  cached brief when an agent change is applied or undone.
- **Reserved names are never reported** (`@general`, `@explore`, `@build`, `@plan`… opencode's own agents), and an `@` glued
  to a word, `.`, `/` or `-` (an email, a URL) is not a mention. A real agent that someone calls by a different `@name` in
  prose is still reported.
- **Only `@slug` mentions are checked.** A line that points to a removed agent by its name ("the pricing writer") is not
  found. Text that isn't a routing line (an agent's instructions body) is not scanned.
- **A folder with an error still counts as existing**, so a mention of a broken agent is not reported; the broken agent has
  its own error row.
- **A create in progress** (its folder is claimed until it is live) is listed as a row with a problem and counts as existing,
  so a line that names it is not reported.
- **At most 10 notes**, then one line with the count of the rest.
- **The Architect's own proposals aren't checked before they are applied** (a proposal that adds a mention of a missing
  agent is flagged only after it is live); the Architect is told about existing notes, not warned about new ones.
- **The planned monthly team review** is where merges and routing fixes beyond "this name doesn't exist" belong.

## The Architect owns every agent change (user request, 2026-11-25)

Problem seen in a live test: undoing an agent from its card (`@pricing-copy-cro`, then `@pricing-cta`) reverted that one
change only. The routing line the same task had added to `@conversion-cro` ("→ @pricing-copy") stayed, pointed at an agent
that no longer existed, and biased the next Architect run. Undo, delete and manual edits have no team-wide view; the
Architect does.

Direction (user): make the Architect the single owner of changes to agents, so every change is checked against the whole
team and conflicts are resolved when they happen. Two shapes to choose between:
- **Undo / delete route through the Architect.** The card's Undo (and an agent's Delete) starts an Architect task
  ("undo this change and keep the team consistent") instead of reverting a file. It proposes the revert plus any neighbour
  fixes (routing lines that mention the agent) in one go.
- **Everything through prompts.** No direct edit buttons; every change, including undo, is a request to Manta, which hands
  it to the Architect.

Open points: what stays instant for safety (a one-click revert must still exist when the Architect is unavailable or a
change went badly wrong); small edits the user dictates (today Manta applies them with `agent_change`); cost and latency of
a full Architect run for a trivial undo; how this relates to the routing-note check (#1733), which stays as the
fact-level safety net.

## Show the Architect's fit check on the proposal card (2026-11-25)

`agent_propose` now stores the fit check (`fitCheck: {researchSays, matches, why}`) on every proposal and the wire carries it,
but `AgentChangeCard` doesn't render it yet; the user sees it only as the first block of the Architect's result. A small
"Fit check" row (and a visible "asked you first" mark when `matches` is false) would put it where the decision is made.

Known gap of the server check: a mismatch is allowed once the task has asked the user (the job's `askedUser` mark). A NEW
Architect task started with the user's answer in its brief has no such mark, so it would be refused on a mismatch and has
to record `matches: true` ("the user confirmed") or ask again. If that shows up in practice, let the lead pass the user's
confirmation into the new task's stamp.
## All-or-nothing release of a task's proposals: edge cases left open

A task's proposals that would apply automatically are released together (`applyGroupLocked` in `src/server/agents.mjs`):
the first one that doesn't end applied stops the group, the ones already applied are undone (their `before` is restored,
OpenCode reloaded) and the rest are marked "not applied". Every Outcome line says which. Known edges:
- **Mixed groups.** Only the proposals that would auto-apply are grouped. A sibling that waits for a click (plan mode,
  Ask, lead/core/isolation change) is released as before; it can still be applied later even if the others were rolled back.
  A routing change that depends on a pending sibling is not tracked.
- **Retry of the failed one.** The proposal that failed keeps its "Retry" on the card and retries ALONE; the rolled-back
  siblings are not re-applied. Wanted: a retry of the failed one re-applies its rolled-back siblings too (or the card says
  "ask Manta again").
- **A rollback that can't happen** (the agent's file was edited since, or the folder holds other files) leaves that
  proposal applied with an error naming why; its Outcome line says it is live but the rollback failed.
- **Failed activation.** The failed proposal itself is taken back too (its folder or previous files, its config block, the
  installed list); the record ends `failed` with nothing live. If the take-back can't finish, the record says what is left.
- **UI.** A rolled-back record shows as "Undone" and a not-applied one as "Not applied"; neither has a dedicated chip.
- **Stale OpenCode locations.** The reload now forgets locations whose folder was deleted (`DELETE /api/debug/location`),
  but nothing prunes them proactively; they accumulate until a reload trips on one. It was written against the 2.0.30
  client's wire definition and a fake server; run it once against a real box with a deleted worktree.

## Non-blocking task questions: edge cases left open (agent screens, S1 server)

Spec `docs/superpowers/specs/2026-11-26-agents-screens.md` §4. The pieces are in `src/server/taskQuestions.mjs` and `src/server/delegate.mjs`.
Verified on the pinned binary by `scripts/opencode-v2/question-capture.e2e.mjs` (the question tool returns the placeholder inside its
"User has answered your questions: …" result, the turn goes on, a steered answer arrives in the same run, a finished task is continued, a
steered message in the child's inbox carries the id we sent it under). Left open:
- **The ending gate is not exercised on the real binary.** The inbox shape and cancel are; the race it closes (a steered answer still
  pending when the turn ends) is only covered with fakes — it is hard to make happen on purpose.
- **Only a round that finished well is deferred.** A round that FAILED (or was stopped) with an answer waiting posts its failure as always, and
  the answer is then sent by the question sweep (≤ 60 s) as a continuation of the failed task. A round that fails with a steered answer
  still unconsumed in its inbox is not taken back by the gate (the gate runs for `done` outcomes only).
- **A stopped task's open question stays open.** Stopping a task doesn't dismiss its question card; answering it later continues the stopped task.
- **A failed delivery after `askedUser` was set.** `deliverToTask` marks the newest round `askedUser` before it sends (so a continuation
  inherits it); if the send is then refused, the mark stays although nothing was answered. It only loosens the Architect's fit-check
  refusal for that task.
- **A answer's recording that can't be written** (the store became unreadable after the send) tells the user their answer WAS sent but not
  recorded; the claim stays and the sweep settles it from the session (a message with the claim's id / a round created with it).
- **Several answers to one task at the same moment** go out one per press (each its own steered message or continuation). Only the answers that
  wait for a round to end are merged into one continuation.
- **The first question's text echoes into the task's messages** ("Answer from the user to your question "<q>": …", cut at 300 characters). It is the
  model's own text quoted back; there is no filter beyond the cut.
- **A real-model probe of the placeholder wording** (spec §4.8) is still to do: the e2e uses a scripted model.

## Agent screens, S2 server (seats, history, fleet, refresh): edge cases left open

Spec `docs/superpowers/specs/2026-11-26-agents-screens.md` §5. Code: `src/server/agents.mjs`, `routines.mjs`, `researchLibrary.mjs`, wiring in `rpc.mjs` / `index.mjs`.
- **The refresh task runs in the user's home, not in the agent's folder.** The spec says the task's parent folder is the agent's `home/`,
  but the delegate refuses any task inside `~/.manta` ("Can't run a task inside Manta's own folders"). The read-only Architect needs no
  project, so `agents.refresh` uses the box user's home. The headless run SESSION is still created in the agent's `home/`.
- **A plain shell window anchors the hidden `manta-agents` workspace** when a refresh task is the first thing to need it (the delegate
  places its window in an existing tmux session only). It is created once with the same name `openChat` uses; closing it is harmless (the
  next refresh recreates it).
- **A refresh run deleted while its task is starting** (the routine removed in that window) leaves the task running; its proposals still
  wait for a click and the task ends on its own, but nothing settles a run. Rare, bounded by the task's own 4 h ceiling.
- **A refresh run's report is lost across the crash window** between creating its session and storing the task id: the run is failed
  after 2 minutes ("the box restarted before the refresh could start") although the task may still run and propose.
- **"Questions answered" in the recap reads the question store's file directly** (`.questions.json`, counting `answered` since the last
  visit) because the question module has no read for it. If that module gains one, use it.
- **Restore does not re-check a pinned model.** A restored version that pins a model nobody approves any more is applied as written (the
  agent would then fail at its next task with the model's own error). Ordinary changes check the approved models.
- **A deleted agent's refresh routine is removed on the next sync; a transiently invalid `agent.md` (mid-edit) also removes it** and it is
  recreated (enabled) when the file is valid again, so an "Off" choice does not survive an invalid edit.
- **Seats are listed by file name only.** A seat file for a project that left the registry still shows (named by its slug) until it is removed.
- **The fleet's grid reads the jobs store, which keeps finished tasks 7 days or 50 records;** older tasks show as "Idle" (by design).

## Agent screens, R2 renderer (chat, task panel, picker): edge cases left open

Spec `docs/superpowers/specs/2026-11-26-agents-screens.md` §2.3, §2.5, §4.4, §6.2, §6.6. Code: `ChatPanel.tsx`, `BackgroundCards.tsx`,
`TaskSidePanel.tsx`, `ResearchRows.tsx`, `ComposerParts.tsx`, `agentDispatch.ts`, `newAgentDraft.ts`, `hooks/useTaskQuestions.ts`.
- **The picker finds the chat's project from its folder name.** The renderer has no folder → registry-project mapping, so
  `resolvePickerProject` matches the folder's name against `agents:projects` (name equal, or the slug's name part) and only accepts a single
  match; otherwise the rows carry no seat pill. A worktree folder named differently from its repo gets no pills. A server channel
  (`agents:project-for {directory}`, answered by `registry.identify`) would make it exact.
- **The new-chat draft (`NewSessionScreen`) has its own `@` list** (`matchAgents`), without badges, descriptions or seat pills. Only the
  chat composer's picker (`TypeaheadPopup`) got them.
- **The lead is not in the picker** (`usableAgents` never offered it: a mention of the lead would not dispatch anything), so "lead first"
  only takes effect if the lead is ever made pickable. The Architect is listed, without a pill.
- **A task question's own `error` text is not drawn under the card.** The refusal sentence the call throws goes on the chat's send-error
  line (spec §4.4); the record's `error` field comes back on the next refetch but nothing renders it.
- **A task question in a chat with no messages yet is not drawn** (the transcript's empty state only shows background and handoff cards).
  A task's chat has talked already, so this cannot happen in practice.
- **"Done · N min" in the task panel is the round's own run time** (`startedAt` → `endedAt` of the shown round), not the whole task across
  follow-up rounds.
- **The panel's Details toggle on a run card with no progress `view` still opens the panel,** which then says "No progress reported yet".

## Agent screens, R1 renderer (Fleet, profile, sidebar): edge cases left open

Spec `docs/superpowers/specs/2026-11-26-agents-screens.md` §2.1, §2.2, §2.4. Code: `src/renderer/agents/**`, `AgentsSection.tsx`, `Sidebar.tsx`, `App.tsx`.
- **"Restore before this" guesses the live version from the records.** The profile has no copy of the agent file, so the live version is
  taken as the `after` of the newest applied change (or the `before` of a later undo). A hand edit is not in the history, so after one the
  button may show where it would change nothing (or hide where it would); the box is the judge and answers "Already at that version".
  An `agents:profile` field with the file's hash would make it exact.
- **The Overview's History is a read-only preview** (first 3 rows, no Details / Restore) and the History tab holds the actions, so a record
  never has two cards with two Undo buttons. A record whose card shows above the tabs (pending, or settled on this page) has no Details row.
- **"Instructions" in the Overview comes from the newest applied change's file text.** An agent with no applied change in the history (a
  built-in nobody changed, or one edited by hand) shows no Instructions fold: the profile wire carries no instructions.
- **"Mention in a chat" finds the seat's folder by name.** The sidebar knows folders, the registry knows names; the match is the picker's
  folder-name rule (`resolvePickerProject`), and only an unambiguous one counts. Otherwise the chat opens in the active project. A
  `folder` on `AgentSeat` would make it exact.
- **The sidebar's agent rows carry no status dot** (the mockup's running / needs-you / failed dots): the rail has no per-agent state read
  other than the Fleet grid's. A `status` per agent in `agents:list` would feed it.
- **The breadcrumb's current page is plain text,** not a link to itself (the `breadcrumbs` guide keeps it a link): a link that does nothing
  would break the no-dead-controls rule.
- **The Fleet grid has no stacked small-screen layout** (the `responsive-table` guide's card form): the desktop window is never narrower than
  a few hundred pixels and the region scrolls sideways with the agent and weekly-count columns pinned. Add the `@container` form with the
  mobile client, if one ever shows this page.
- **The profile reads the fleet and the project list on every hint** (soft reads for each seat's current task and "Add a seat"): cheap on
  the box today; a per-agent `agents:fleet {slug}` would trim it.
- **No visual-registry row for the task side panel.** It needs an agent task in the chat's job store, which no demo state has yet (the `agents`
  demo state serves the two pages).
- **Fixed in passing (R2's store): `openTaskPanel` didn't wake the readers of the right slot,** so Details opened nothing until another
  render happened. It emits now (`explorerStore.test.ts`, "opening it wakes what is already rendering the right slot").

## Needs you (rule set P1) — edge cases left for later

- **A merge is not an event.** An item leaves when its branch has landed, but nothing tells the Fleet page that a merge happened:
  it clears on the next read (a reload, a hint from any other change, or the page being reopened), at most ~30 s after the box's
  branch check cache expires. A hint on merge (or a periodic refetch while the page is open) would make it instant.
- **Which branch counts as "landed".** The check asks whether the task's branch tip is already in the project checkout's HEAD or
  in `origin/HEAD`, or the branch is gone. A branch merged only into some other, non-checked-out branch stays until the user opens the
  task or marks it done.
- **A Manta-handed task the user later continues themselves** keeps `requestedBy: "manta"` (a continuation inherits it), so its
  unmerged branch is a recap line, not an item. Deciding that a user's own follow-up message takes ownership is a product call.
- **The "still unmerged" recap line** counts every finished Manta-handed task still in the jobs store (7 days / 50), not only those
  since the last visit; it leaves when the branch lands or the task is opened.
- **Failures the user asked for** get a recap line with Open; the research's "Retry" chip is not built (retrying is a new request).
- **`reviewed` is capped at 200 job ids** (oldest dropped): opening or marking done more than that in one stretch lets the oldest
  item reappear if its branch is still unmerged.
- **The "thin" research tag is warn-toned everywhere** (the task side panel shares the rows); nobody asked for the panel to differ.

## Profile tabs (proposal A) — edge cases left for later

- **"Next refresh" on the Research pane.** The mockup shows a date; the refresh routine's next run isn't on the profile read. Worth adding once the routines read exposes it.
- **Page titles for sources.** The library keeps a claim, quote, link and publisher per finding but no page title, so a source row is the publisher or site. A stored title would give the mockup's "site — page name" rows.
- **Private sources are counted per finding, not per source,** because the library's wire shape doesn't say which private findings share a source.
- **"Also used by" is derived from applied changes' basis** (the research a change rested on), not from every task that read an entry; an agent that read it without changing anything isn't listed.
- **Restore for a change shown above the tabs.** A record whose card is above (just applied) has no row to open, so "Restore the version before this" isn't offered for it; its own Undo does the same thing.
- **Seat briefs are shown whole.** A 4000-character brief makes a tall row; clamp with "Show more" if that turns out to matter.


## From Architect v2 PR A (template upgrades, bundle snapshots, problem + trials, 2026-11-27)

- **The trial's progress line.** The spec has the trials module report "Trial running · case 2 of 3" through the Architect job's
  `jobProgress` label; PR A only records the cases (`agents:trial`). The label belongs with the renderer's progress line (PR B).
- **The profile's trials list.** `AgentProfile.trials` (the Tests tab) is not part of `agents:profile` yet; PR B adds it from `agentTrials.list(slug)`.
- **A VM sandbox for trials.** Trials have no shell (an agent that needs commands gets a partial test: what it couldn't run shows
  as a refusal in the case record), because no ruleset can confine a shell on this box. Real command runs need a throwaway VM
  (the Freestyle account is the candidate); until then the Tests tab's wording says "no shell".
- **A trial's folders live in a private 0700 base in the OS temp folder, not under `~/.manta/agents/.trials/`.** The task
  rulesets protect `~/.manta` by absolute path, which only holds for a session whose folder is outside it. Each case works in a
  standalone `git clone --local --no-hardlinks` of the project's current HEAD (uncommitted files are not copied).
- **Clean template upgrades apply automatically at every level** (with Undo); only a merge conflict waits for a click (spec §2).
  If the lead / Architect should always wait for a click, say so.
- **A pending template update that nobody clicks expires after 24 h** like any change; the next boot offers it again
  (an expired record doesn't count for the dedupe).

## From Architect v2 PR C (skills, 2026-11-27)

- **"Upstream moved" only knows commits.** The refresh brief compares a copied skill's `provenance.ref` with the upstream repository's
  HEAD (`git ls-remote`, 5 repositories at most, asked once a day) and only when `ref` is a 40-character commit. A tag or a branch
  name can't be compared with where the upstream is now without a stored commit, so such a skill is never listed. The template
  tells the Architect to give a commit; resolving a tag to its commit at proposal time (one more network read) would close this.
  The weekly check-up's fact sheet (PR D) reads the same `skillUpdatesFor(slug)` (it asks the network within the 10 s budget); it is not
  wired there yet. The refresh brief reads the cache the sweep warms once a day, so the first refresh after a restart may carry nothing.
- **Upstream diffs.** The brief says the upstream moved, not what changed in the skill's files (spec §11: "upstream skill diffs
  before an update").
- **The `skills` source needs `npm` on the box's PATH the first time.** It runs `npm ci --ignore-scripts` from the committed lockfile
  (`src/server/research/skillsCli/`) into `~/.manta/tools/skills`; with no npm, or no network, the source answers with a fixed
  sentence (and doesn't try again for 10 minutes) and the Architect uses GitHub or the web. Moving the pin = regenerate the lockfile
  (`npm install --package-lock-only --ignore-scripts` in that folder) and bump `SKILLS_CLI_VERSION`. The tool folder is not swept.
- **Searches are recorded per task session in `~/.manta/research/<session>/searches.json`** (last 200, swept with the sources).
  A `skillSearch` is checked against the searches of every round of the root task; extra (user-defined) sources record the query
  but no refs, so a candidate can't be justified by an extra source's result alone (it can by `skills_installed` or a base search).
- **The script review is a model reading text.** It catches clearly harmful scripts, not subtle ones; Undo removes the skill, not what a
  script already did. A real sandbox run of copied scripts (a throwaway VM) would be the next step, with the trials' VM item.
- **The review's model pair is fixed** (opus ↔ sonnet, spec §4.1): a box with neither approved gets a verdict of `error` and a click.
- **A removed skill's origin isn't shown on its card** (the record keeps what was removed, not where it came from).
- **Skills are plain text only.** A skill folder that holds a binary or a non-UTF-8 file can't be replaced or snapshotted through
  a proposal (the bundle is text); the agent's other files are untouched.
- **Native OpenCode skill scoping per agent** (spec §8, §11) stays a spike: the compiled index still lists an agent's skills.

## Parallel work by the same agent

- **Dispatch the same agent several times in parallel.** Today a chat runs at most one code-editing task of a teammate at a
  time, so independent pieces (e.g. a server PR and a renderer PR of the same spec) queue behind each other and the lead
  falls back to generic background jobs. Allow several concurrent tasks of the same agent when they own disjoint files /
  branches (each already gets its own worktree), with a per-chat cap, and show them as separate task cards. Asked by the
  user on 2026-11-27.
