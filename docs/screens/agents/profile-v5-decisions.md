# Agent profile v5: what changed and why

Mockup: `docs/screens/agents/profile-v5.html`. It is a throwaway, self-contained file and supersedes v4.

**Switchers:**
- Agent, theme, width, Save result and Conversation (Ongoing or First time), as in v4.
- **Dev's status** is new: Working, Finished, Asking or Idle. It drives Dev's Team dot. The Product Designer's dot is always Working.
- URL parameters: add `&team=run|ok|att|default`.

**Mock behaviour:**
- Saves never reach the box.
- The conversation is a static sketch.
- Team rows, the ⋯ menu and the history rows do open.

Kept from v4: the Sections index, the Skills and Settings tabs, the Team section, the summarized-earlier marker, and one Chat button. The Architect has no Chat button.

## 1. The Team dot is the session dot

The Team rows now use the sidebar's own session row (`SessionRow.tsx`, the `.srow` row in `docs/screens/redesign-spec.html`): **dot · name · age**, with the same selected marker. There is no new dot, and the "anything new" dot is gone.

| Agent state | Dot (from `SessionRow` `DOT`) | Same as a session that is… |
|---|---|---|
| Working (its conversation or a task it started is running) | `run`: `--accent` blue, 3px `--accent-bg` ring, pulse | running |
| Asking you something (a question or permission is open) | `att`: `--danger` red, `--danger-bg` ring, faster pulse | waiting on a question or permission |
| Finished and you haven't looked yet | `ok`: `--ok` green | done, unseen |
| Nothing going on | `default`: `--tx4` grey | idle |

The tooltip copy comes from `dotFor` in `Sidebar.tsx`: "Asking you something — click to answer", "Done — click to view".

The agent's badge is dropped from the row. `SessionRow` is one line, dot · name · age, by contract, and a badge would need a new slot in a shared primitive. If the badge is wanted, adding that slot is a separate change to `SessionRow` (open decision 2).

## 2. The conversation reuses the existing chat panel

The view is `ChatPanel` with its `SessionHeader` and `InputArea`. The transcript, the question card and the task cards are the existing components (the user bubble, assistant text, `QuestionCard`, the background `RunCard`). Only these differ from a project chat:

**Session header (`SessionHeader.tsx`)**

| Part | Agent conversation | Why |
|---|---|---|
| Breadcrumb (workspace / session) | **Kept**, as "Team / Dev" | It still names where you are. |
| Branch chip, PR and Checks popover | **Removed** | The conversation runs from the agent's home folder, which has no branch. Each task card names its own branch. |
| Context pill | **Kept** | It shows how full the conversation is, which is when summarizing happens. |
| Artifacts toggle | **Kept** | The agent still sends you files. |
| Explorer toggle | **Removed** | The home folder isn't something to browse. A task's files open from its card. |
| "Hand off" button and auto-handoff mode | **Removed** | One persistent conversation is summarized in place; it isn't moved to a fresh session. |
| Session menu: Compact | **Kept**, as "Summarize earlier messages now" | It does the same thing, named as the user sees it. |
| Session menu: Clear | **Kept**, as "Clear conversation…", with a confirmation | It's a fresh start. What the agent learned stays, and the menu says so. |
| Session menu: Fork, Delete, chat/terminal mode, Move | **Removed** | There is exactly one conversation per agent, so there's nothing to fork, delete or move. Clear covers starting over. |
| A **Profile** button | **Added** | It's the way back to the agent's profile. |

**Composer (`InputArea.tsx` and `ComposerParts.tsx`)**

| Part | Agent conversation | Why |
|---|---|---|
| Input row: textarea, mic/voice, Send/Stop, attachments, paste, screenshot strip | **Kept** | This is composing. Nothing about it changes. |
| `@` files, `/` commands typeahead; Enter sends now, ⌥Enter after this turn | **Kept** | The same behaviour as a project chat. |
| Usage dial | **Kept** | The plan quota is shared by every conversation. |
| Model picker (model, effort, fast) | **Removed** | The agent's model is set in its Settings tab. A per-message override would quietly undo that. |
| Plan chip (plan mode) | **Removed** | The conversation itself doesn't edit files; edits happen in tasks, on their own branch. |
| Trust row ("Permissions on — click to bypass") | **Removed** | What an agent may do is set by your autonomy settings, the same for its tasks. A per-conversation bypass would contradict them. |
| Session toolbar (⏰ schedules, 🔑 secrets, 🪝 webhooks, 🤖) | **Removed** | They belong to a project session. For an agent: schedules are Routines, secrets are handed through Manta, and nothing outside should wake this conversation. |
| Optimizer "↓ N% this conversation" pill | **Kept** (when it shows) | It's harmless and still true for this conversation. |
| Background-run checkbox for slash commands | **Kept** | Same reason as `/` commands. |

The shell keeps the existing classes: the bordered input row (`rounded-lg`, `border-border-subtle`, `px-4 py-3`) and the meta row under it. The mockup draws it with the session mockup's composer styles.

## 3. A global chat: no project chip

- **One folder:** the conversation always runs from the agent's home folder. The project chip and the "Works in…" hint are gone.
- **The agent works out the project** from what you say and what came earlier. "The pairing screen" means MantaUI; "the invite API" means Ronda. It names the project in its reply.
- **Task cards show the project:** each task the agent starts shows its project as a chip, with the branch.
- **It asks only when it genuinely can't tell.** The sketch shows the existing question card: "Which project is the flaky upload test in? Both MantaUI and Ronda have one, and nothing earlier says which." It offers each project and a free-text answer. While it's open, Dev's Team dot is red.

## 4. History lists only applied changes, one compact line each

- **Only live changes:** pending and waiting rows are gone, and so is "Review in Needs you". The note under the list says changes waiting for your click are in Needs you.
- **The row is one line:** date and what changed. "Live", "you approved it" and the "Tested" chip are no longer in the row.
- **The expanded details hold the rest:**
  - who made the change and how it landed (e.g. "Architect · you approved it");
  - "Tested before it went live · 3 of 3 cases passed", with each case;
  - the change itself;
  - Undo (on the newest live change) and "Restore the version before it". Restore isn't offered on "Created …".

## Open decisions (default applied first)

1. **Finished-and-unseen is green, and turns grey once you open the conversation** (applied), the same as sessions.
2. **Team rows have no agent badge**, to keep `SessionRow` unchanged (applied). The alternative adds a badge slot to `SessionRow`.
3. **Clear is kept, with a confirmation, and keeps learned preferences** (applied). The alternative is no Clear at all, so the conversation can never be reset.
4. **The model picker is removed** (applied). The alternative is a read-only model name in the meta row.

## What @dev will need on the server

1. **The conversation's folder is always the agent's home.** Each task the agent starts runs in the project it chose: that project's folder, its seat, a branch there. The task card carries the project.
2. **Two new tools for the agent:**
   - **list its projects**: its seats, with names and a one-line description. The agent uses them to match what the user said.
   - **start a task in a named project**: the delegate path with a project argument.

   If the agent names a project it has no seat in, starting a task there adds a seat, as today.
3. **Asking which project uses the existing question flow** (`question.asked`), so the Team dot turns red and Needs you shows it like any other question.
4. **Which project's notes go into context:** only the notes of a project the conversation is working in. The agent loads them when it picks the project, so one project's memory doesn't leak into another.
5. **The Team row's dot comes from the same status as a session's.** The conversation's running and attention state, plus its running tasks, is rolled up the way a chat window's dot already includes its background jobs (`dotFor`). No new status kind.
6. **The composer and header changes are client-only.** Hide the listed controls for an agent conversation. "Summarize now" calls the existing compact. "Clear conversation" clears the session's messages and keeps the agent's learned preferences and project notes.
7. **History** reads only applied changes. Pending ones stay in Needs you.

**Acceptance criteria**
- Each Team row uses `SessionRow`, and each of its four dot states matches a session's.
- The agent conversation has no model picker, plan chip, trust row, schedules/secrets/webhooks buttons, branch chip, Explorer, Hand off, Fork or Delete. It does have the context pill, artifacts, usage dial, attachments, voice, `@`/`/` and Send/Stop.
- There is no project chip. Task cards show their project. An ambiguous request shows the question card, and the Team dot turns red.
- History rows are one line each. Nothing pending appears. The details show who made the change, the tests, the change itself and Undo.
