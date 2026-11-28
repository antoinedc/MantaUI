# Tasks an agent starts from its own conversation: design decisions

Mockup: `docs/screens/agents/chat-tasks.html` (throwaway, self-contained). Use the **State** switcher, or URL parameters
`?state=<id>&theme=light|dark&w=420|900|1280`.
Spec: `docs/superpowers/specs/2026-11-28-agent-chat-tasks.md` (§7, §9). It builds on `profile-v5.html` (conversation,
tokens) and Fleet / Needs you v10 (`docs/screens/fleet/mockup-v10.html`).

**Mock behaviour:** nothing talks to a box.
- Open session, Details and Open Fleet show a note.
- Submit on the project question jumps to "running".
- Open conversation in Needs you jumps to the question.
- ⋯ → Clear conversation… opens the native dialog.

**Checked:** 19 states × light/dark × 420/900/1280, rendered in Chromium. No script errors and no sideways scroll.

**Not checked:** the impeccable launcher was refused (permission), so its detector didn't run. I checked the markup and
computed values myself. Contrast uses the existing token pairs, which are already audited in v5 / v10.

## 1. The task card is one variant of the existing cards

For a job with `startedFrom: "agent-chat"`, `RunCard` (while live) and `BackgroundResultCard` (once the result is in) use
the same head. Both stay the existing components; only their head row changes.

```
[spinner | outcome dot]  Title (h4, 1 line, ellipsis)          Details   Open session
                         [📁 Ronda] · In progress · 3/7 · 4m · ⑂ agent/dev/… · Sonnet 5.5
                         Headline from the box (1 line)
                         ──────────── plan bar
                         Added @dev to Ronda
                         (result card: 2-line result text · Show more)
```

- **Title** is `displayTitle(job)`, in a heading element, never `name`. The `“…”` request line is dropped (spec §7).
- **Project chip** is `job.project.name`, as plain text, not a link.
- **Status words are Fleet's words**, so the card and the Fleet row never disagree. Running: "In progress",
  "Paused by you". Ended: "Done", "Didn't finish", "Interrupted", "Stopped by you", plus the existing "Needs a decision".
  Map the ended words with the same function Fleet uses (`endedBadge` and its outcome). Don't add a second mapping.
- **Branch** is `job.branch`, in mono. It reads "read-only" (eye icon) when `isolation === "none"` or the branch is null.
- **Model** is optional. It's shown only once the parallel "model per task" change puts it on the job (the user asked
  for it on the chat card). If that change isn't there yet, leave it out.
- **Narrow (transcript under 520 px):** the title wraps to 2 lines and Details / Open session move to the card's last
  row. Nothing else moves.
- **Accessible names:** each card's buttons are named after their task ("Open session: Fix the flaky upload test"),
  because one conversation holds several cards.

| State | What shows | Data (spec / box) |
|---|---|---|
| Starting | Spinner, title, project chip, "Starting…". No Details or Open session (nothing to open yet). | The `agent_start_task` tool part while pending/running: `input.title`, and `input.project` → name from the projects list the renderer already reads (`agentsProjects`). |
| Waiting for approval | The starting card says "Waiting for your approval". The existing approval card sits under it. | The panel's existing `pendingApproval` for this session. |
| Running | Spinner, "In progress", steps · elapsed, headline, bar | `job.status running` + `view` (existing). |
| Running, task asks | "· 1 question" in warn. The task's question card shows as today. | `OpenQuestionsByJobContext` (existing). |
| Paused by you | Grey dot, "Paused by you", last steps. Resume stays in Fleet. | `job.status paused`. |
| Couldn't confirm | Existing words: "Couldn't confirm this started — open the session to check" | `launchState: "uncertain"`. |
| Done | Green dot, "Done", result text (2 lines + Show more), "Open session →" | `background-result` part, which replaces the running card (existing pairing). |
| Needs a decision | Warn dot, "Needs a decision" | `endedBlocked`. |
| Didn't finish / Stopped by you / Interrupted | Red / neutral / warn dot and Fleet's word | `part.state` through Fleet's outcome mapping. |
| Refused | **No card.** The tool row reads "● Not started · <title>", with the sentence the agent got back, verbatim, underneath. | The tool part's output `Not started: <error>` (the job never existed). |
| Seat added | "Added @dev to Ronda" (existing line) | `job.seatAdded`. |

**Result text:** if `part.text` starts with the completion's status or `Project:` lines, the card hides them, because the
chip already says it. The model still gets the full text.

## 2. Asking which project: the existing QuestionCard

How it reads (the agent writes it; the guidance should carry this pattern):
- **Header:** "Which project?"
- **Question:** "Which project is the flaky upload test in? MantaUI and Ronda both have one, and nothing earlier in our
  conversation says which."
- **Options:** one per candidate project, with the project name as the label. The description is the one fact that
  distinguishes it ("Its upload test failed twice this week"). Put the recommended one first, marked "(Recommended)",
  **only when there is a reason**. At most 4 options.
- **Free text:** always on (existing).

While it's open: Dev's Team dot is red, and the composer placeholder reads "Answer above, or message Dev…" (v5).

## 3. Needs you item for a conversation question

It's the v10 item shell with no new component:
- **Label:** "Waiting on you" (red). Nothing moves until it's answered: no task exists yet. This is the decision tier,
  unlike task questions ("Open question · keeps working"), which never block.
- **Group:** under the **"Team"** heading, the agent-level group where agent changes already sit. The question has no
  project yet. Extend the label rule so the no-project group reads "Team" when it holds only changes and conversation
  questions.
- **Title:** the question text. **Who-line:** badge, **Dev**, "in your conversation".
- **Sentence:** "Dev is waiting for your answer before it starts anything. Options: Ronda (recommended), MantaUI." The
  options come from the form, with "(Recommended)" turned into "(recommended)".
- **Action:** one bordered button, **Open conversation**. It selects Dev's conversation, where the card answers it. It is
  not answered here (spec open question 2). If it fails, a `role=alert` line under the button says "Couldn't open Dev's
  conversation; try again".

## 4. The agent naming the project (copy pattern; the agent writes it)

One line after starting, then stop. The project name must be exactly the one on the card.
- **It knew from context:** "I'll do this in **Ronda**: its upload test is the one that failed twice this week. I've
  started a task and will tell you when it's done."
- **New seat:** "I'll do this in **<Project>**. I haven't worked there before, so I've added myself to it."
- **Read-only:** "I'm looking into this in **Ronda**, read-only: I won't change any files."
- **Reporting a result** (2–4 lines): "Done in **Ronda**: <what changed and why, checked against 'done when'>. Next:
  <one step>." For a task that didn't finish: "That didn't finish in **Ronda**: <reason>. Nothing was changed. Want me to
  try again?"
- **Never:** naming a project id or a folder path, or saying "I'll start a task in the project" without the name.

## 5. Clear conversation refused

Placement: the existing confirm dialog that "Clear conversation…" opens (native `<dialog>`). When tasks are in flight, the
dialog opens already in its refused state, using the job store. It can also land in that state after Clear was pressed,
when the server refuses (a race). Both show the same thing:
- **Title:** "Clear your conversation with Dev?"
- **Warn alert** (`role=alert`), the server's sentence: "Dev has 1 task running from this conversation; wait for it or stop
  it first."
- **The tasks** (title · project · status), so "them" is concrete. An in-flight start reads "Starting…".
- **Sentence:** "Its result comes back to this conversation, so clearing now would lose it. Stop a task from Fleet."
- **Buttons:** Open Fleet · **Close** (focused). No Clear button in this state.

The allowed state is unchanged: "The messages are removed and a fresh conversation starts. Dev keeps its instructions,
skills, learned preferences and project notes." Buttons: Cancel · Clear conversation.

## 6. Fleet: no new design

The task is a normal v10 running / Ended today row, with the project from `job.project`. One gap that doesn't change the
row: Details' "Asked by" has no value for these tasks (`FleetAskedBy` is you / Manta / routine). The recommended value is
"Dev, in your conversation".

## Open decisions (recommendation applied in the mockup)

1. **Singular/plural in the Clear sentence.** The spec pins "<Name> has N task(s) running…; wait for them or stop them
   first". Recommended: the server pluralizes ("1 task … wait for it or stop it first"). The mockup shows that.
2. **The model in the conversation.** v5 removed the conversation's model picker, but spec AC-1.7 speaks of "the model
   the user picked in the conversation's model picker". With v5 as built, the task's model is the agent's model unless
   the handoff-level override (the parallel change) names another. Recommended: keep v5 (no picker) and read AC-1.7 as
   "the model of the calling message". The user should confirm.
3. **Model on the card.** Shown last in the meta row, because the user asked for it. Recommended: keep, once the field
   exists.
4. **The refusal sentence is shown verbatim**, even the model-facing one ("call agent_projects and use an id from its
   list"). Recommended: keep verbatim (one source of truth); the agent's next line explains it in plain words.
5. **A conversation question in Needs you is "Waiting on you" (red)**, not "Open question". Recommended, because nothing
   moves until it's answered.
