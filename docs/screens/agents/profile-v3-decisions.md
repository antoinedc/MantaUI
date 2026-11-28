# Agent profile v3: what changed and why

Mockup: `docs/screens/agents/profile-v3.html`. It is a throwaway, self-contained file and supersedes `profile-v2.html`.

**Controls:**
- Agent (Dev, Architect, Product Designer), theme, and width (420, 900, 1280, fill).
- **Designer: change waiting**: adds a pending row to the Designer's History.
- **Save result**: Saves or Fails, to show the Settings states.
- URL parameters for screenshots: `?agent=&theme=&w=&tab=&pd=&save=&screen=chat&project=&picker=1&demoSave=<field>`.

**What is mock behaviour:**
- Saving waits 450 ms and never touches the box.
- "Review in Needs you" shows an alert.
- The conversation view is a static sketch.

**Content:**
- Real, read from `~/.manta/agents/*/agent.md` on 28 Nov 2026: the instructions, descriptions, use-when/not-for lines, models and colours, the Architect's two skills, and the Designer's `impeccable` skill (from its `SOURCE.md`).
- Illustrative: seats, learned rules, history rows, trial cases and the chat exchange.

## The user's feedback, and what changed

| Feedback | v3 |
|---|---|
| Skills belong in their own tab | **Skills tab**, after Seats. Same content as v2: name, one-line description, provenance and licence, size, Source link. **Empty state:** "No skills yet. When a proven skill fits Dev's job, the Architect proposes it; you'll find it in Needs you, then here." |
| Remove the line count and "from agent.md" | Removed. The Overview is a plain "Instructions" heading followed by the formatted text. |
| The "On this page" outline is confusing | Removed. Long instructions (the Architect's, about 100 lines) read as one formatted document. |
| The "Waiting for you" card feels out of place | **Removed from the profile.** Pending changes live in Needs you. History still lists a pending change as "Waiting · for your click" with a **Review in Needs you** link. |
| A Settings tab, so settings are shown clearly | **Settings tab**, the last tab. Details below. |
| Remove "Change via Manta" and "Mention in a chat"; just a Chat button that isn't a throwaway | **One Chat button.** Each agent gets one persistent conversation per project. Details below. |

## Settings tab

There are three groups. Each field shows its current value and a control.

**Identity**
- Name: text field, 40 characters max.
- @handle: field with a fixed `@` prefix; lowercase letters, numbers and dashes. Its help says that renaming moves the agent's seats and history, and that old `@dev` mentions stop working.
- Description: 300 characters max, with a counter.

**When to use it**
- "Use it when" and "Not for": 200 characters each, with counters. "Use it when" says Manta reads it when deciding whether to hand work to this agent.

**How it works**
- Model: Auto or a pinned model.
- Works: "On its own branch" or "Read-only", each explained in one line.
- Refresh with new research (specialists only): Monthly or Off, on the 1st, 8th, 15th, 22nd or 28th, with "Next: 1 Dec".
- Learn from your corrections: "Team setting (learn and tell me)", "Learn and tell me", "Ask me first", "Don't learn". The team default comes from the autonomy `learn_preference` setting; this is a per-agent override.

**States, shown in one line under each field:**
- **Unchanged:** nothing appears. Leaving a field without changing it doesn't save.
- **Saving…** while the save runs.
- **Saved:** "Saved · added to History · Undo". Undo restores the previous value and says "Undone · back to the previous value".
- **Error:** "Couldn't save: the box didn't answer. Your text is kept. Try again". The value stays in the field.
- **Invalid handle:** "Use lowercase letters, numbers and dashes." Nothing is saved.

**Saving and History:** each field saves when the user leaves it, with no Save button. Each save is recorded in History as an ordinary agent change. Dev's History shows one: "You · in Settings — Model: Auto → Sonnet 5.5", with its diff and Undo.

**Agents that can't be edited** (the Architect; the same applies to Manta, the lead):
- A note at the top: "Architect is built into Manta, so its name, handle, wording and how it works change only through Manta: ask in any chat. Those changes always wait for your click. Model and learning are yours to set here."
- The locked fields show their value as plain text, with "· via Manta" next to the label.
- Model and learning stay editable.

**Research tab:** the refresh control moved to Settings. Research keeps one line: "Refreshed monthly, on the 1st … Change in Settings".

## Chatting with an agent (recommended design, applied)

Today, Chat opens a single conversation per agent. It runs in the agent's own home folder, not the project, and lives in a separate "agents" space. That is why it feels like a throwaway: it has no project, no code, and nothing to come back to.

**v3 design:**
1. **One persistent conversation per agent per project.** Chat opens it, creating it the first time.
2. **It shows in the sidebar under its project**, with the agent's badge, next to the project's other sessions. You can come back to it any time. The sketch shows Dev under MantaUI and under Ronda.
3. **It runs as the agent:** its instructions, skills, learned preferences and that seat's brief and access. It works in the project's folder.
4. **Its history stays across sessions.** Tasks the agent starts from it appear as task cards in the conversation (sketch: "Fix the pairing error wording · Working · 2/4").
5. **From the profile:**
   - One seat: Chat opens that project's conversation.
   - Several seats: a small native popover picker, "Chat with Dev in…", lists each project with "Last message 2h ago" or "New conversation".
   - No seats: the picker lists projects and says that choosing one gives the agent a seat there.
   - Each seat row in the Seats tab also has "Open chat" or "Start a chat".
6. **Asking it to change itself** goes through the normal change flow. A rule about how it works becomes a learned preference; an instruction change becomes a change card. Both appear in History with Undo. The sketch shows a learned preference being added.
7. **The Architect has no Chat button.** It shows "Works through Manta: ask in any chat." This matches today's server refusal.

**Conversation header:** the agent's badge, then "Dev · MantaUI", then "Your conversation with Dev in MantaUI · runs as @dev with its instructions, skills, preferences and seat", and a "Profile" link back. At 420 px the sidebar hides.

**Alternatives considered:**

| Alternative | Why not |
|---|---|
| Keep one global conversation per agent (today) | The agent has no project context, so it can't touch the code it is talking about. That is the throwaway feeling the user described. |
| A new conversation every time Chat is pressed | That is exactly the throwaway behaviour. It also scatters context and makes learned corrections harder to trace back. |
| Mention the agent inside the project's existing chat (`@dev`) | It mixes the lead's and the agent's turns in one thread, and nobody can tell who is answering. Mentions stay available for handing off a task; they are not "talking to" the agent. |
| One conversation per agent, with a project switcher inside it | One thread would cross projects, so seat access and notes would change mid-conversation. That is confusing and risks leaking one project's memory into another. |
| A chat drawer on the profile page | It hides the conversation away from the sidebar where the user's other work lives, and it can't be reopened after navigating away. |

## Kept from v2

- Use it when / Not for above the tabs.
- Single column, no side panes.
- Access only on each seat.
- Tests folded into History.
- No Seats tab for the Architect.
- Tabs: Overview · Seats · Skills · Learned · History · Research · Settings.

## States checked (420, 900 and 1280 px, light and dark)

- **No skills:** Dev's Skills tab shows the empty state.
- **Long instructions:** the Architect's Overview, about 100 lines with numbered steps and code spans, reads cleanly at 420 px with no horizontal overflow.
- **Can't be edited:** the Architect's Settings show the lock note, read-only values and editable Model and Learn.
- **Save error:** with Save result set to Fails, the error line keeps the edited text and offers "Try again".
- **Saved and Undo:** both shown.
- **Chat:** the picker (several seats), direct open (one seat), and the conversation view at 1280 and 420 px.
- **Pending change:** shown only in History, with "Review in Needs you".

## Open decisions (default applied first)

1. **One conversation per agent per project** (applied). Alternatives are in the table above.
2. **The Architect gets no Chat button** (applied); people reach it through Manta, as today. The alternative is a per-project Architect conversation, which would need the server's refusal lifted.
3. **Settings save per field, with Undo** (applied). The alternative is a form with one Save button.
4. **Renaming the @handle is allowed, with a warning** (applied). The alternative is to make the handle fixed after creation, because renaming breaks old mentions.
5. **The refresh day can be the 1st, 8th, 15th, 22nd or 28th** (applied). The alternative is Monthly/Off only.
6. **"Change via Manta" is removed from the profile** (applied). Free-form changes go through the agent's own chat or any Manta chat; structured ones go through Settings.

## Hand-off to @dev (summary)

**Must keep**
- No pending-change card on the profile.
- Skills is its own tab, with the empty state.
- The Overview has only the formatted instructions: no line count, no source, no outline.
- Settings save per field, each save recorded as an agent change with Undo, showing the saved, error, unchanged and invalid states.
- Locked fields for the Architect and Manta, with the note.
- One Chat button that opens the agent's conversation for a project, with a native `popover` picker when the agent has several seats.

**Needs a backend change**
- A per-project agent conversation that runs in the project folder and appears in the sidebar under that project.
- Settings writes through the existing agent-change path, so they show in History.
- A per-agent learning-level override.
- A refresh-day setting on the refresh routine.

**Acceptance criteria:** the states listed above, one test each. Check the picker, tabs and form fields against the modern-web-guidance skill (`popover`, `tabs`, `forms`, `:user-invalid`).
