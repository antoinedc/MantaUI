# Agent screens — deliberate differences from the mockup

The mockup (`mockup.html`) is the visual reference. These are the places where what gets built differs on purpose.

1. **Existing cards are drawn as they ship.** The question card, the change card, the result card and the run card in the
   mockup are transcriptions of `QuestionCard`, `AgentChangeView`, `BackgroundResultCard` and `RunCard`. Any pixel
   difference between those drawings and the shipped components is resolved in favour of the components. The earlier
   restyle ideas (inline "asks you · keeps working meanwhile" question message with option chips, compact Apply/Discard
   rows, "Recommended" in accent) are **later**.
2. **No "Asked … / You chose …" line in the transcript.** The answered question leaves the chat; the answer is recorded
   as a server milestone in the task's details and side panel.
3. **"Done · waiting for you" / Undo-in-message** of the approved mockup became the result card with the change card
   inside it; Undo exists only on the change card.
4. **Side panel "What happened" is `JobDetails`** (checklist marks + milestones + stats), not the earlier timeline with
   icons and per-step times. The panel shows whatever the agent reported; there are no fixed step names.
5. **Needs-you items are full cards** (question card with Submit/Dismiss, change card, result card) under a context line,
   not compact one-line rows with inline reply chips.
6. **Review item:** "View diff / Review" became the result card's "Open session →" plus a "Done" button; the diff review
   is the existing Review mode inside the opened session.
7. **Profile header:** "Edit charter" is **Change via Manta** (opens a chat draft); a **Chat** button (direct chat) is
   added for specialists.
8. **History** lists only changes made through Manta, the Architect or Restore; hand edits are not listed. "Restore
   previous" on every row became **Restore before this** only where it would change something; the latest applied
   change's undo is its card's Undo.
9. **Fleet:** "All projects" is a static label (no filter). Plan usage is the highest current plan-window percentage, or
   absent. "Tasks this week" counts launches since Monday (box-local ISO week). Cells older than the jobs store's
   retention read "Idle".
10. **Memory map** shows what the knowledge tools give a task in that project; it doesn't claim the agent can't read other
    projects' files on disk ("other seats are invisible" is reworded to "other projects' memory: only if they share").
11. **Picker pill** "working here" is not built; pills are "seated here" / "adds to <Project>".
12. **Type and spacing** snap to the token scale (10 px initials → `text-micro` 11; 20 px name → `text-title` 17;
    off-grid paddings to the nearest step) — see `contract.md` §Tokens.
13. **Sidebar** keeps the existing rail metrics (14 px agent badges, density tokens); the mockup's 22/16 px badges are for
    the pages only.
14. **Fleet column** is 1120 px wide (the other pages' column is 960) so four project columns and the weekly count fit; the weekly
    count stays pinned at the right edge when more columns make the region scroll.
15. **Breadcrumb**: the current page is text with `aria-current="page"`, not a link to itself (no control that does nothing).
16. **Profile Overview**: Charter shows the agent's description / use when / not for / works / model from the profile, not the mockup's
    hand-written Does / Doesn't / Asks first lines; its History block is a read-only preview of the first three rows.
17. **Review item** in Needs you: the context line carries the agent, project, task and age; the result card is the shipped
    `BackgroundResultCard` (Open session →); "Done" is a ghost button in the context line.
