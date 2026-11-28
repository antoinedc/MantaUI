# Agent profile v2 — what changed, what was cut, and why

Mockup: `docs/screens/agents/profile-v2.html` (throwaway, self-contained). It has controls for the agent (Dev, Architect,
Product Designer), the theme (light, dark), the width (420, 900, 1280, fill) and whether the Product Designer's change is
waiting or applied. URL parameters `?agent=&theme=&w=&tab=&pd=` open any state directly.

Content: the instructions, use when / not for, descriptions, models and colours are the real agents' (`~/.manta/agents/*/agent.md`,
28 Nov 2026). The Architect's skills are its real ones. The research rows are real research library entries. Seat briefs,
learned rules, history rows and trial cases are made up to look realistic.

## Problem

People open an agent's profile to answer three questions: **when should I use it, what exactly does it do, and where does it
work**. The current page spreads the answers across a side pane, a folded code block and five or six tabs. The same facts appear
twice (seats, access, refresh), and every tab carries a side pane of explanation. The redesign works if a first-time visitor can
answer the first two questions without scrolling past the tabs or opening anything.

## Required changes (all applied)

| # | Change | Where it is now |
|---|---|---|
| 1 | **Use it when / Not for** moved above the tabs | A tinted two-column strip under the header: side by side when wide, stacked under 640 px. An agent without them shows "Nothing written yet. Change via Manta can add it." |
| 2 | **Research it relies on** removed from the Overview | Only in the Research tab |
| 3 | **Full instructions** shown in full as formatted text, not a folded code block | The Overview opens with them: headings, numbered and bulleted lists, bold lead-ins, inline code, about 68 characters per line. A leading `# <Agent name>` heading is dropped because the page header already says it. When there are 3 or more sections and the page is at least 760 px wide, an **On this page** outline stays visible beside them and highlights the section you're reading. It also links to Skills. |
| 4 | **Skills** section | Under the instructions: name, one-line description, where it came from and its licence (`Copied whole from pbakaus/impeccable · Apache-2.0 · 118k stars`, or `Written for this agent`), then size and a Source link. With no skills, one sentence explains how skills arrive. |
| 5 | **Access** removed from the side column | Only in the Seats tab, on each seat. Nothing was added to the header (see "Not added"). |

## Further simplifications applied

| Cut or merge | Why |
|---|---|
| **The side pane on every tab is gone.** Every tab is one column. | Most of the panes were explanations repeated on each visit ("What a seat is", "About the library", "How changes land", "How rules are learned", the trial safety note). The two real controls moved into the tab: **Add a seat** at the end of the seat list, **Refresh with new research** at the top of Research. Each explanation is now one quiet line at the top or bottom of its tab. |
| **Details facts merged into the facts line** (`@dev · Specialist · Edits code · Sonnet 5.5`). "Built by" and "Changed" dropped. | Model and what it does to code are the two facts that matter before using an agent. Who built it is the oldest History row, and the last change is the newest one. |
| **Seats list removed from the Overview** | The Seats tab label carries the count, and the tab holds the list. Showing it twice is what made Access grow. |
| **Refresh control in one place** (Research tab) | It appeared in both the Overview pane and the Research pane. It's a research setting. |
| **Research "Health" counts dropped** | Each row already carries a fresh, stale or thin tag. |
| **History "Summary" counts dropped** | Each row shows its status, and the tab shows the total. |
| **Tests tab folded into History.** A change the Architect tested shows `Tested · 3 of 3 cases passed`. Opening it lists each case (expected to do it or decline, the result, a quote) next to the change itself. | A trial is evidence for one change, so it belongs with that change. It also removes a tab that appeared and disappeared depending on the agent. |
| **Seats tab hidden for the Architect and the lead.** The facts line says "Works in every project". | Their Seats tab had nothing to show or do. |
| **Tab order: Overview · Seats · Learned · History · Research** | The tabs you use day to day come first. Research is reference material, so it moved to the end. |
| **Seat with no brief** says what a brief is for and offers **Write a brief** | Today's seats all have empty briefs, so this is the common case. |

## Not added

- **An Access summary in the header.** Access depends on the seat, and today every seat has the same default (its project's notes
  read + write, the agent's know-how and the research library read, other projects no access). A header line would repeat a default
  that says nothing about this agent. "Edits code" / "Read-only" in the facts line is the one access fact that differs between agents.

## Suggestions (not applied)

1. **Show a seat's access only when it differs from the default.** The tags currently repeat the same four entries on every seat. Showing them only for an exception would shrink the Seats tab further. This needs the box to say what "default" means.
2. **Merge Learned into History**, as one "What changed" log with a Learned filter. Both answer "why does it behave like this now". I kept them apart because learned rules aren't changes to the agent's file and Undo works differently. Only a test with real users can settle whether people look for them in one place.
3. **Hide empty tabs** (Research with 0 entries, Learned with 0). That means fewer tabs, but agents would have different tab sets, and the empty state is where the page explains what the tab will hold.
4. **Two header buttons instead of three.** Make "Chat" the primary action and move "Mention in a chat" into its menu. At 420 px the three buttons take a full row.
5. **Drop "Specialist" from the facts line.** Nearly every agent is a specialist, so the word only carries information for the Architect and the lead.

## Open decisions (the default I applied comes first)

1. **Instructions before Skills** (applied), or Skills first. Skills is short, but the instructions are what the agent *is*, and the outline links straight to Skills.
2. **Tests shown only inside History** (applied). Trials that never became a proposal are no longer listed anywhere. The alternative is a "Trials not used" line at the bottom of History.
3. **Empty Skills shows the section with one sentence** (applied). Today's code hides the section when an agent has no skills.
4. **The outline appears only with 3 or more sections and 760 px or more** (applied). The Dev agent has no sections, so it gets none.

## Hand-off to @dev

**Must keep**
- Use it when / Not for above the tabs and the pending change cards, in the header area. The pending cards stay where they are (deliberate friction: a change waits for a click).
- The Overview is the full instructions rendered as Markdown with the app's existing `MarkdownBody` (react-markdown, already in the project). Don't use a `<pre>` block and don't write a new renderer. Drop a leading `# <name>` heading that matches the agent's name.
- A Skills section on the Overview, using the existing `AgentSkills` row content (`provenanceLine`, `skillSizeLine`, `OriginLink`). Show it with an empty-state sentence when there are no skills.
- No side panes: `TwoColumn` / `Pane` are no longer used on the profile. Add a seat and the Refresh control move inline as described.
- Access appears only on each seat row in the Seats tab.
- Tests are folded into History rows (chip + cases in the expansion). The Tests tab is removed.
- The Seats tab is not rendered for the Architect or the lead.
- The tabs keep today's behaviour (the `tabs` guide recipe, a roving tab stop, arrow, Home and End keys).
- Both themes, no new tokens. Container queries: the header actions wrap under 640 px, the use strip stacks under 640 px, and the outline hides under 760 px.

**Nice to have**
- The outline highlights the section in view (IntersectionObserver), and the in-page links use `scroll-margin-top`. Scroll smoothly only when `prefers-reduced-motion` allows it.

**Open decisions**: the four above. Don't invent alternatives.

**Libraries considered**

| Need | Chosen | Considered / why |
|---|---|---|
| Markdown rendering | existing `MarkdownBody` (react-markdown) | A new renderer: rejected, the project already has one |
| Outline position | CSS `position: sticky` + anchor links | A scrollspy library: rejected, IntersectionObserver is enough |
| Folds (history, research, evidence) | native `<details>` | Unchanged from today |

Check the outline, the folds and the tabs against the modern-web-guidance skill (`tabs`, `details`, `scroll-driven` / `scroll-margin` guides).

**Acceptance criteria per state**
- *Ideal:* use when and not for show above the tablist. The Overview's first content is the instructions as headings and lists, with no `<pre>`. Skills list name, description and provenance with the licence.
- *No use when / not for:* the strip shows "Nothing written yet. Change via Manta can add it." for the missing one.
- *No skills:* the Skills heading plus one sentence; no list.
- *Long instructions (the Architect, about 100 lines, 3 sections):* at 760 px or wider the outline shows each section plus Skills, and clicking an entry scrolls to it. Below 760 px there's no outline and nothing overflows horizontally at 420 px.
- *Lead / Architect:* no Seats tab; the facts line ends "Works in every project"; no Chat button for the Architect.
- *History with a tested change:* the row shows "Tested · N of N cases passed". Its expansion lists each case with expected (do / decline), result and quote, plus the change and Undo on the newest live change.
- *Research:* the Refresh control (specialists only) sits above the entries. There's no Health block. An empty list shows the empty sentence.
- *Seats:* each row shows the project, notes, current task, brief (or "No brief yet…" + Write a brief) and that seat's access tags. Add a seat appears after the list. Remove asks first.
- *Loading, error and invalid agent:* unchanged from today.
