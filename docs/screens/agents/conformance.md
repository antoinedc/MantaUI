# Agent screens — deliberate differences from the mockup

Compared with `npm run visual:compare agents-fleet agents-profile agents-profile-research agents-profile-seats agents-profile-history` (app left, `mockup.html` right; the profile tabs were reviewed against `profile-tabs-mockup.html`, the `agents-profile-research|seats|history` rows, and the Overview against `profile-overview-mockup.html`) for the two `agents-*` rows,
in light and dark (`VISUAL_COLOR_SCHEME=dark`). The mockup (`mockup.html`) is the visual reference. These are the places where what
gets built differs on purpose.

Last reviewed: 2026-11-26 (62a142ef)

## Deliberate

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
16. **Profile tabs** follow the approved layout A: Overview (`profile-overview-mockup.html`) and all four tabs (`profile-tabs-mockup.html`, its first button; the B and C proposals in that file were not chosen). They are not `mockup.html`'s profile screen. Overview: "How to
    use it" lists the agent's real use when / not for (the mockup's "Asks first" / "Measures" rows are illustrative copy: there is no
    such data, so no such row), then full instructions folded and the research; the details pane holds details, seats, access and
    refresh. History is a tab only; Tests has no tab and no box until it exists.
17. **Review item** in Needs you: the context line carries the agent, project, task, **why it is here** ("Needs a decision" /
    "Branch ready to merge · N files") and age; the result card is the shipped `BackgroundResultCard` (Open session →); "Done" is a
    ghost button in the context line. Only rule set P1 puts a task here (spec §2.1); everything else is a recap line.
18. **Pending change on the profile** is the shared change card with the optional `collapsed` prop: one summary line (chip, who and
    what, Discard · Apply) and the change folded. Buttons are in the mockup's order (Apply last); the card's own order elsewhere is
    unchanged. "based on N sources" counts the record's evidence (the mockup names a research entry; records carry no basis topic).
19. **Badge initials** are drawn in whichever of white or near-black has the better contrast on the agent's own colour; the
    mockup's white-on-green is 3.4:1. The 44px profile badge sets its initial at 15px (`text-prose`), the mockup's size.
20. **Details pane** stacks under the main column below ~720px of the page's own width (a container query), not of the window's; its
    note under Access ("Know-how changes only through change cards.") is not drawn — each row's note is its tooltip.
21. **Recap** gained the Manta-handed lines and an Open button on a user-requested failure; "Needs you · <reason>" in a grid cell is the
    same reason the list shows.
22. **Research tab:** a source row shows the publisher or site as the link and has no page title (the library keeps none); private sources are
    counted ("N private sources aren't listed" — the library doesn't say which findings share a source, so it counts findings). "Used by" lists
    other agents whose applied changes rest on the same entry, not every task that read it. The pane has no "Entries" or "Next refresh" row
    (the tab already counts the entries; the box doesn't say when the refresh runs) and "Missing" appears only when an entry is gone.
23. **Seats tab:** each seat keeps its current-task line (real data, spec §2.2) under the project name; the mockup has none. Edit brief's
    buttons read Save / Cancel; Add a seat's button reads "Add" under the pane title "Add a seat".
24. **History tab:** the pending change's row says "see the card above" and has no Details (a second card would be a second Apply / Discard);
    the mockup lets it open. The "who" badge is the neutral agent badge for everyone (the mockup tints "You"). Restore sits inside the
    opened row, as in the mockup, so a change shown above the tabs (just applied) is restored by its own Undo instead. The opened card's chip
    keeps the card's own word ("Updated") beside the row's "Live".

## Open

- The task side panel and the Create-an-agent chat screens have no registry row (the `agents` demo state serves the Fleet page and
  the profile; the panel needs an agent task in the chat's job store).
- The sidebar's agent rows carry no status dot (the mockup's running / needs-you / failed dots).
- The demo's recap has no earlier visit ("In the last 24 hours").
