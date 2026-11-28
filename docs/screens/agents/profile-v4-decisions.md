# Agent profile v4: what changed and why

Mockup: `docs/screens/agents/profile-v4.html`. It is a throwaway, self-contained file and supersedes v3.

**Switchers**
- **Agent, theme and width**: as in v3.
- **Designer: change waiting**: shows a pending change in History.
- **Save result**: Saves or Fails.
- **Conversation**: Ongoing or First time.
- **URL parameters**: add `&screen=chat&convo=new&picker=1` to open a state directly.

**Mock behaviour**
- Saving never reaches the box.
- The conversation view is a static sketch; Send does nothing.
- The Team rows and the project picker do work: they switch the agent or the project.

Everything else is as in v3: no pending card, Skills and Settings tabs, one Chat button. The Architect has no Chat button.

## 1. The index on Overview is back, labelled "Sections"

It is the same as in v2:
- **When it shows:** a list on the right of the instructions, kept in view while you scroll, when the instructions have 3 or more sections and the page is at least 760 px wide.
- **Behaviour:** it highlights the section being read, and clicking an entry scrolls there.
- **Skills:** the index no longer links to Skills, which has its own tab.

**Label: "Sections."** It describes exactly what the links are: the sections of the instructions. "On this page" was confusing because this page also has tabs and a header, which the list doesn't cover. "Contents" suggests a document's full table of contents.

I kept a label rather than none. Without it, a column of short phrases ("Never", "Style", "Gotchas") next to the text reads like stray tags. The label is one quiet line. For screen readers it is a `nav` named "Sections of the instructions".

## 2. One conversation per agent

The per-project conversations, the project picker on Chat and the "Open chat" links on seats are gone.

### Where it lives: a Team section in the sidebar (applied)

- **Team section:** under the projects, the sidebar lists each agent you can talk to, with its badge and name. A dot appears when something there is new, such as a reply or a finished task. "All agents" opens the Agents page.
- **The profile's Chat button** opens the same conversation.
- **The conversation view:**
  - **Header:** the agent's name and a "Profile" link back to its profile.
  - **Messages:** the conversation itself.
  - **Composer:** a box with a project chip.
- **At 420 px:** the sidebar is hidden, as it is everywhere in the app (⌘B / sidebar button). The conversation is still one press from the profile.

| Alternative | Why not |
|---|---|
| **A Chat tab inside the profile** | The profile is for reading and settings. Making it the place you talk means a chat box inside a tabbed page, sharing scroll with the instructions. It's also two clicks deep (Agents, then the agent, then the tab) for something you'd use daily. |
| **A chat drawer on the profile** | It goes away when you navigate, has no place in the sidebar to come back to, and makes the conversation feel temporary, which is the problem we're fixing. |
| **Under each project in the sidebar** (v3) | You asked for one conversation per agent, not one per folder. |
| **Inside the Manta lead's chat via @mention** | One thread would mix the lead's turns and the agent's, so it's unclear who is answering. @mentions stay as the way to hand off a task, not the way to talk to an agent. |

### Which project a request works in

The conversation spans projects:
- **The project chip:** in the composer, showing "MantaUI" or another project with a chevron, next to the hint "Works in MantaUI unless your message says otherwise". It defaults to the project last used in this conversation. Picking a project the agent has no seat in shows "adds a seat".
- **The agent can infer the project:** if the message clearly names another project, the agent switches, says so ("That one's in Ronda… so I've switched to Ronda"), and the chip follows. If it's unclear, it uses the chip's project, and asks only when getting it wrong would be costly.
- **Every task card shows its project** as a small chip, so two tasks running in different projects are easy to tell apart. Each of your messages carries a quiet "in MantaUI" note.

### How context works over a long conversation

There are three layers, modelled on how mainstream chat assistants work:

1. **Recent messages stay in full.** When the conversation gets long, older messages are summarized automatically (OpenCode already compacts sessions this way). A thin divider marks where: "Earlier messages summarized · Show". Show opens the summary text ("Summary of 142 earlier messages (26 Nov – today)"). The full old messages stay in the conversation's history; only the agent's working view is summarized.
2. **Lasting things live outside the conversation, so summarizing never loses them:**
   - **The agent's instructions and skills.**
   - **Its learned preferences:** the corrections it was given, reviewable in the Learned tab.
   - **Each project's notes and seat brief:** the project knowledge.

   These load at every turn. Only the current project's notes are used, so one project's memory doesn't leak into another's work.
3. **Visible but quiet.** The header carries one line: "Remembers: its instructions, skills, 2 learned preferences, and each project's notes. Recent messages in full; older ones summarized." The first-time conversation explains it once: "One ongoing conversation across your projects… What it learns from your corrections is kept even when older messages are summarized."

**What this is based on.** I saved it to the research library today (thin: 2 publishers).
- **Anthropic's compaction docs:** older turns are replaced by a model-written summary, recent turns can be kept word for word, and quality degrades as a conversation grows.
- **Claude Code's memory docs:** each session starts with a fresh context, and knowledge carries across through instruction files and an "auto memory" written from the user's corrections. Here those are the agent's instructions and learned preferences.
- **OpenAI's ChatGPT Memory and Projects help pages:** memory keeps what's relevant, not everything. It's reviewable and correctable, and replies show the sources that shaped them. Projects scope instructions and memory, and "project-only memory" keeps context inside a project. Here, project notes are used only for that project.
- **Cursor:** its docs page didn't load in this task, so it isn't a source.

## Open decisions (default applied first)

1. **The conversation lives in a Team section in the sidebar** (applied). Alternatives are in the table above.
2. **The index label is "Sections"** (applied). The alternatives are "Contents" or no label.
3. **The project defaults to the last one used, and the agent switches when the message names another project and says so** (applied). The alternative is to always use the chip and never infer.
4. **Show the summary** opens the summary text (applied). The alternative is to reveal the full older messages inline.
5. **The Team dot means anything new** (applied): a reply, or a task finished or needing you. The alternative is to show the dot only when the agent needs you.
6. **The Architect isn't in Team and has no Chat button** (applied, as in v3).

## What @dev will need on the server

1. **One persistent conversation per agent**, replacing today's per-agent chat, which runs in the agent's home folder in a separate "agents" space. The conversation's own folder can stay the agent's home. Each task it starts runs in the selected project's folder, under that project's seat.
2. **A "working project" on every message:** the composer chip sends it, and the server records it. The agent can change it from the message. When it does, the reply carries the new project and the UI updates the chip. Task cards carry their project.
3. **Adding a seat when the user picks a project the agent has no seat in.** This is the existing "add a seat" path.
4. **Per-turn context:** instructions, skills, learned preferences, plus the selected project's notes and brief. Only that project's notes.
5. **Compaction keeps the latest turns in full**, using OpenCode's session compaction, and exposes a "summarized up to message N" marker plus the summary text, so the UI can draw the divider and Show.
6. **An unread signal per agent conversation** for the Team dot: a new reply, or a task finished or needing you.
7. **Sidebar:** a Team section fed by the agent list, with only agents that can chat.

**Acceptance criteria**
- **Profile Chat:** opens the agent's single conversation, the same one as its Team row.
- **No per-project chats:** no picker on Chat and no seat chat links.
- **Index:** "Sections" appears only with 3 or more sections at 760 px or wider.
- **Project chip:** defaults to the last used project. When the agent switches, the chip and the next task card both show the new project.
- **Summary divider:** appears once compaction has happened, and Show reveals the summary.
- **Header:** the "Remembers…" line is always present, and its learned-preferences count matches the Learned tab.
- **First time:** the first-time empty state is shown when the conversation has no messages.

Check the composer picker and the sidebar against the modern-web-guidance skill (`popover`, `anchor positioning`, `details`).
