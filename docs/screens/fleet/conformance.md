# Fleet and Needs you — deliberate differences from mockup v10

Reference: `docs/screens/fleet/mockup-v10.html` (decisions: `decisions-v10.md`). Compared with
`npm run visual:compare agents-fleet agents-needs` (app left, mockup right). Built to the spec
`docs/superpowers/specs/2026-11-28-fleet-redesign.md`. The pixel and structure baselines for `agents-fleet` were removed with the
old grid page and `agents-needs` has none yet: regenerate both with `npm run visual:update` (needs the build, which was not run
where this was written), and review the diff against the mockup.

## Deliberate

1. **No "Earlier days" link and no "Should have asked me" control** (Ended today footer, ended Details). Nothing backs either yet
   (a history read, a learning signal), and a control that does nothing is not allowed. Follow-ups in `docs/agents/follow-ups.md`.
2. **A task that ended needing a decision keeps the existing result card and its Done button**, not the mockup's option list
   with Submit. Answering a finished task goes through the lead (`agent_handoff` + `continueJob`); there is no direct channel.
3. **The box cap is the server's (10), not the mockup's 5.** "Can't resume yet: N tasks are already running" reads it from the box.
4. **The checklist in Details has no per-step times.** The box's progress view carries the steps and their state, not their
   durations. It also shows nothing for the "Task" row of the mockup (the box has no separate technical task name).
5. **"Manta recommends …" is derived from facts on the change** (a flagged script / content review, a failed trial case), not a
   stored recommendation: a clean change recommends approving, a flagged one recommends reading it first.
6. **An answered question leaves a status line, not an Undo.** The mockup's done rows carry Undo; an answer is steered into the
   running task and cannot be taken back. An applied agent change keeps its own card with the card's Undo.
7. **Needs you is ordered longest-waiting first** (decisions, then questions), so the oldest request is on top.
8. **Items with no project** read "Team" (agent changes made in a chat) or "No project".
9. **Agent names in rows are not links** (the old grid opened profiles from them); the sidebar's agent rows do.
10. **Skeleton and banners share one component pair** (`Skeleton`, `ReadBannerView` in `FleetPage.tsx`) for both pages.
