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

- **Existing boxes keep their old Architect.** `installBuiltIns` never overwrites an existing folder, so a box's
  `~/.manta/agents/architect` (agent.md and `skills/research/SKILL.md`) does not get the new instructions by itself.
  Phase 5B's built-in update feature should compare the shipped template with the installed one (and keep the user's
  edits). Until then the files are copied by hand.
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
- **A create in progress** (its folder is claimed until it is live) doesn't exist yet, so a line that already names it is
  reported until the create finishes.
- **At most 10 notes**, then one line with the count of the rest.
- **The Architect's own proposals aren't checked before they are applied** (a proposal that adds a mention of a missing
  agent is flagged only after it is live); the Architect is told about existing notes, not warned about new ones.
- **The planned monthly team review** is where merges and routing fixes beyond "this name doesn't exist" belong.
