# Research layer screens: decisions

Spec (source of truth): `docs/superpowers/specs/2026-11-28-research-layer.md` (§4 US1, US4, US5; §6.6 contracts; §9 design).

Mockups (self-contained, no network; open the file in a browser):

| File | What | Switchers / URL |
|---|---|---|
| `sources.html` | Settings → Research sources (20 states), plus the "Suggest agents for repeated work" switch in Settings → Sessions | `?state=<id>&theme=light\|dark&w=420\|900\|1280`; demo bar also has **Save result** (works / fails) |
| `profile-and-suggestion.html` | The sources line on an agent's profile (5 states), Manta's suggestion card (9 states) and the blocked-search row (2 states) | `?screen=profile\|chat&state=<id>&theme=…&w=…`; demo bar also has **Post result** (works / fails 5 times) |

**Mock behaviour:**
- Nothing talks to a box.
- Switches, ↑/↓, Test, Add, Edit, Remove and the card's buttons only change the page's own state.
- Test answers after about 1.2 s with a canned result.
- Accepting a suggestion shows "sending" for about 1.5 s.
- Links to other screens show a note instead of navigating.
- The list re-renders on reorder. The real list must move the existing nodes (see the guides below).
- Dragging is drawn (the handle) but not wired. Use ↑/↓ in the mock.

## Problem (2–3 lines)

The box owner can't see, test or rank the sources agents search. Bookface is buried in the Architect's file, so only the Architect can use it.

The page works when the owner can find Bookface in Settings, see that it's private, test it and move it to the top in under a minute. A second sign: any agent's profile answers "what does this agent search?".

Repeated requests never turn into a teammate. One quiet offer, answered once, should fix that without nagging.

## What was reused (nothing new where a primitive exists)

| Surface part | Reused from | Notes |
|---|---|---|
| Settings window: section rail, header, groups, rows | `Settings.tsx` + `docs/screens/settings/mockup.html` (`.snav`, `.sethead`, `.setgrp`, `SettingsRow`) | New section **Research sources** in the AGENT group, right after Knowledge (`SETTING_SECTIONS`, `wide: true` like Secrets). |
| On/off | `Toggle.tsx` (`button role="switch"`, 36×20 track) | Chromium has no native `<input switch>`, so the existing Toggle wins (guide `switch` fallback). |
| Buttons, pills | `Button`, `Pill` / `Tag` looks | **Private** uses the accent pill and **Outside** the neutral outline pill. These are existing tones, not new tokens. |
| Notices (migration, load error, older box) | The profile's `.locknote` panel, `UpdateBoxNote` | — |
| Add / Edit / Remove | Native `<dialog>` + `showModal()`, as `StopTaskDialog` / `ClearBlockedModal` | — |
| ⋯ row menu | Native `popover`, the profile v5 picker look | — |
| Edit form fields | The profile v5 settings field styles and `Field`'s label class | Validation uses native constraints with `:user-invalid` / `aria-invalid`. |
| Profile line | profile v5 header, tabs and Research tab (`AgentResearch.tsx`: rows + "About the library" block) | Only the sources block at the top of the tab is new. |
| Suggestion card | `DelegateApprovalCard` shell (`.appr`: accent hairline, card background, small actions) | Same family as the approval card that already sits under Manta's messages. |
| Chat transcript, result card | `docs/screens/agents/chat-tasks.html` (user bubble, `BackgroundResultCard`) | — |
| Blocked-search row | The "Not started" tool row (`.trow`) from `chat-tasks.html` | — |

New components: none. There is one new layout block, the profile's sources line (a `<dl>`, built from the `PaneFacts` key/value idea).

## Decisions

### Settings → Research sources

1. **One ordered list, not two.** Your sources and the defaults share one `<ol>`, and the position number is the priority. A user source can sit below a default if the user wants that. This is what `research:sources-save` stores (one ordered list).
2. **Your sources are on top by default.** Migration puts them first (open question 5, recommended option), and **Add source** inserts a new one at the top of your sources. The dialog says so, so the user isn't surprised.
3. **Each row shows:**
   - name, id (mono) and the **Private** or **Outside** label;
   - the description agents read;
   - a meta line: the command or address (mono) or "Built in", "Moved from the Architect", warnings and the off reason.

   Controls on the right: **Test**, ↑, ↓, ⋯ (Edit…, Remove…, user sources only) and the on/off switch.
   - Built-ins keep an empty ⋯ slot, so the columns line up. They have no Remove (AC-1.7).
   - At 420 px the controls drop under the text. The switch stays at the right edge.
4. **Reorder:**
   - Visible ↑/↓ buttons are the keyboard path (guide `drag-and-drop`: "visible movement controls … best default for discoverability").
   - The grip handle is for pointer drag, with a drop marker (no live shifting).
   - The grip also takes Space to pick up, arrows, Space to drop and Esc to cancel.
   - Each move saves at once. One `role="status"` line says "Bookface (YC) search moved to position 2 of 10" (guide `dynamic-sort`: announce once, keep focus on the control).
5. **Saving is instant, like the rest of Settings** (switch, reorder, remove).
   - **Saved:** a quiet "Saved" line.
   - **Save fails:** the list goes back to how it was and the line says why, e.g. "Couldn't save the new order: the box didn't answer. The list is back to how it was; try again."
   - Add and Edit save from their dialog. A failed save keeps everything typed and shows the error in the footer.
6. **Private / Outside label on every row**, with a one-line legend above the list:
   - **Private:** "may receive project details; agents use it but never quote or name it."
   - **Outside:** "agents keep private project details out of what they send."

   The words match the base block agents get (spec §6.3), so the user and the agents read the same rule.
7. **Migration notice (AC-1.1b, AC-1.14, AC-1.15):** one note at the top. It:
   - names the moved sources;
   - says "Every agent can search them now", which answers "where can I see Bookface";
   - carries the exact sentence "Sources moved from the Architect are private; make one public here if you want";
   - lists each rename ("Your `packages` is now `packages-mine`, because "packages" became a built-in source");
   - lists each skipped entry with the old validator's sentence, plus "It was never usable; add it again with Add source if you still want it."

   It has a hide (×). The contract has no acknowledge call, so hiding is per device (mock: page state). See open decision B.
8. **Making a migrated source public** is done in Edit: untick **Private**. A warn line then states the consequence: "Outside: agents will keep private project details out of everything they send to this source." It isn't a row toggle, because widening is rare and deliberate (AC-1.1b).
9. **Test:**
   - Pressing Test runs at once with the query "test".
   - A panel opens under the row with the query (editable), **Run again** and **Close**.
   - **Running:** "Searching "test"… this can take up to a minute."
   - **Works:** "Works — 8 results in 1.4 s. First: "…"".
   - **Private source:** adds a sample of the first 200 characters (AC-1.11).
   - **Fails:** shows the search's own sentence, e.g. "The source's secret YC_TOKEN is missing", with **Add it in Secrets**.
   - Nothing is saved to the library.
10. **Missing secret (AC-1.9):** the row meta shows "⚠ Missing secret YC_TOKEN · Add it in Secrets". It names the secret, never a value. The link opens Secrets with the name filled in.
11. **Add / Edit form:**
    - **Fields:** Name, Id (auto from the name until edited; can't change when editing), "What it's good for", and "How Manta reaches it" (Program on this box / Web address).
    - **Program:** "Program and arguments, one per line". One argument per line matches the stored argv exactly; quoting rules never come up.
    - **Address:** an https address with `{query}`.
    - **Environment variables** (program) or **Headers** (address).
    - **Private** checkbox, on by default (FR-002).
    - **Secrets:** an "Insert a secret" select lists secret names from Secrets and inserts `{secret:NAME}` into the focused value. **Manage secrets** opens Secrets. Values are never shown.
    - **Footer:** Test (runs on the unsaved source, which the contract allows), Cancel, Add source / Save.
12. **Refusals in the form are shown at the field, after interaction** (guides `validate-input-after-interaction`, `accessible-error-announcement`):
    - Built-in id (AC-1.13): ""packages" is a built-in source id. Pick another, e.g. packages-mine."
    - Credential literal (AC-1.8), the existing hint: "Put this value in Secrets and use {secret:NAME} in a header or env value."
    - The footer sums it up: "Not added. Fix the 2 fields marked in red." Nothing is written.
13. **The 20-source limit (AC-1.12)** shows as a count ("20 of 20 of your own"). **Add source** is disabled, with the reason under it: "At most 20 sources of your own. Remove one to add another." The project rule: a control that can't act is disabled with a reason, never dead.
14. **Web off (AC-1.6):**
    - The row dims and says "Off: agents can't search the web".
    - Other sources say "Off: agents don't search it".
    - No confirmation. It's one click to undo, and the row says the effect.
15. **Remove** asks for confirmation (deliberate friction on a destructive action): "Agents stop searching it. What they already learned from it stays in the research library. Its command and settings are deleted; the secret it uses stays in Secrets."
16. **States covered:** ideal (migrated), renamed + skipped, fresh box, loading, load error, older box, missing secret, web off, test running / works / fails / built-in, save failed, limit, add (program), add (address), add refused, edit (make public), remove.
    - **Fresh box (empty state):** a dashed hint above the defaults says "No sources of your own yet. Add one to have agents search it first: a forum you're a member of, your team's wiki, an internal search. Agents already use the defaults below." It has an Add source button.
    - **Loading:** skeleton rows.
    - **Load error:** "Couldn't load research sources. Couldn't reach the box. Check that it's running, then try again." with **Try again**.
    - **Older box:** "Update the box to manage research sources here. Until then only the Architect searches Bookface and other sources of your own."
17. **"Suggest agents for repeated work" sits in Settings → Sessions**, in the Agents group with the autonomy settings. The spec says "Settings → Agents", but no such section exists. Sessions is where agent behaviour is set today (AutonomyCard). Help text: "When you ask Manta for the same kind of work 3 times, it offers once to make a dedicated agent or a skill for it. At most one offer a day in a chat. Turning this off keeps counting, so turning it back on works on recent requests."

### Agent profile

18. **Where the line goes:** at the top of the **Research** tab, above "Research it relies on". The Overview tab is instructions-only in v5, and the header facts row would overflow with ten names. The Research tab is where "what does it search" belongs.
19. **What it shows:** a two-row key/value block, the `PaneFacts` idea set as a line.
    - **Searches, in order:** the enabled sources joined by "·", each private one with a lock icon (screen readers hear "(private)").
    - **Library:** "214 entries · 12 saved by Dev".
    - Under it: "The same for every agent on this box." and **Change in Settings → Research sources**.
    - It has no edit control (AC-5.2).
20. **States:**
    - **Web off:** web isn't in the list (AC-5.3), and a quiet "· Web is off" follows the list so the missing name is explained.
    - **Fresh library:** "0 entries · none saved by Dev yet".
    - **Architect:** the same line (AC-5.1).
    - **Older box** (no `research` field): the block isn't drawn; the tab is as today.

### Manta's suggestion card

21. **Form:** a small card directly under the Manta message that carried the third handoff (`anchorMessageId`), in the `DelegateApprovalCard` shell, with a ✦ icon.
    - The text is the spec's wording, with the kind in bold: "You've asked for **weekly release notes** 3 times — want a dedicated agent?" or "… — want a skill for it?".
    - The `why` from the check shows as one muted line.
    - It is server-produced and rendered from `agents:suggestions`, never only from the live event.
22. **The four answers:**
    - **Make an agent**, **Make a skill**, **Not now** and **Don't ask again for this**.
    - The button that matches the verdict is primary, so "Make a skill" is primary when the check says a skill is enough. Both stay available.
    - "Don't ask again for this" is a quiet text button on the right. At ≤ 460 px it moves to its own line.
    - The task names "Make an agent / Make a skill"; the spec's AC-4.3 says "Build an agent". The design uses **Make** everywhere (one name per action). The spec should be aligned (open decision A).
23. **Resolved states replace the buttons with one status line.** The question stays, dimmed, and the card turns quiet (panel background, plain border). The lines:
    - **Posting:** a spinner and "You chose Make an agent. Sending your answer to Manta…". A crash-recovered `posting` offer looks the same.
    - **Posted:** "✓ You chose Make an agent. Sent to Manta as your message below." The posted user message ("Yes — build a dedicated agent for weekly release notes. Earlier briefs: …") follows, then Manta's normal reply.
    - **Failed (5 tries):** "You chose Make an agent, but it couldn't be sent: the box didn't answer after 5 tries. Nothing was lost." with **Retry** (the same act call, same message id).
    - **Not now:** "Not now. Manta asks again after 3 more requests like this."
    - **Second Not now:** "Not now. Manta won't suggest this again; ask it any time if you change your mind."
    - **Don't ask again:** "Manta won't suggest an agent or a skill for weekly release notes again. You can still ask it for one."
    - **Answered elsewhere** (`already`): "✓ Already answered on another device: Make an agent."
24. **"Don't ask again" has no confirmation and no undo.** It is cheap (the user can always ask Manta directly), and the spec has no un-dismiss. The resolved line says exactly what was promised.
25. **"Seen"** (`agents:suggestion-seen`) is sent when the card is actually in the viewport (IntersectionObserver), not on render off-screen. The spec says "in the DOM", but the transcript is virtualised. Recommendation for @dev; see open decision C.

### Blocked search (outside-query check)

26. **Form:** one quiet tool row, the same shape as "Not started": a red dot, **Search not sent** · web, and the server's sentence verbatim under it.
    - Private material (AC-2.8): "This query would send private material to an outside source; rephrase it in general terms, or use a private source".
    - Check unavailable (AC-2.9b): "Couldn't check this query for private material; try again".
    - The query text is never shown in the row; it held the private material.
    - The agent's next, general search shows as the normal tool row. In the mock it is sketched with the same row in green; it stands in for the existing tool card.

## Open decisions (taken with the recommended option; the user can overrule)

- **A. Action names:** "Make an agent" / "Make a skill" (task wording) instead of the spec's "Build an agent". **Recommended: Make.** It's shorter, it matches "Make a skill", and the posted message keeps the spec's "Yes — build a dedicated agent for …". The spec's AC-4.3 label should be updated.
- **B. Hiding the migration notice:** the contract has no acknowledge, so hiding is per device (localStorage). **Recommended:** per device now. Follow-up: `notices` gain an id and a server-side dismiss if users ask.
- **C. When "seen" fires:** when the card is ≥ 50 % visible, not merely mounted. **Recommended:** visible. Otherwise an offer in an off-screen part of a long chat counts as shown and is never withdrawn.
- **D. Placement of the suggestion switch:** Settings → Sessions (no Agents section exists). **Recommended:** Sessions, Agents group.
- **E. Profile line placement:** top of the Research tab (not the header). **Recommended:** Research tab. If testers miss it, add "Searches N sources" as a header fact later.
- **F. Built-in descriptions:** the mock's wording, for code to own (spec §6.1). Reddit and X say "Searched through Exa, a third-party service", so the Outside label is explained.

Only a test with real users can settle:
- whether the Private / Outside legend is understood without the tooltip;
- whether the profile line is found from the Research tab.

## Accessibility and responsive

- **Keyboard order in a row:** grip → Test → ↑ → ↓ → ⋯ → switch. The DOM order matches the visual order at every width.
- **Focus:** visible on everything. The row draws the ring when its grip has focus. The list sits in the settings body, under a sticky header that is not an overlay, so focus is never hidden behind it.
- **Targets:** at least 24×24 px (icon buttons 28 px; the quiet "Don't ask again" link has a 24 px minimum height).
- **Contrast:** body and meta text use `--tx1` to `--tx3` (≥ 4.5:1 in both themes). `--tx4` is used only for separators and the handle icon.
- **Announcements:** reorder, toggle, save, Test result and card answers go through one `role="status"` (or the card's own status line). Errors use `role="alert"`. Dialog errors are tied with `aria-describedby`.
- **Reduced motion:** spinners, skeleton pulse and switch slide stop under `prefers-reduced-motion: reduce`.
- **Narrow (≤ 820 px):** the Settings rail hides and a back arrow appears. Row controls wrap under the text (≤ 600 px). Dialog fields go to one column (≤ 520 px). The card's "Don't ask again" moves to its own line (≤ 460 px). The profile line stacks key over value (≤ 520 px).
- **Checked with screenshots** at 420, 900 and 1280 px, light and dark, for every state of both files (216 captures, no script errors). Interactions were also clicked through in Playwright: reorder, toggle, Test, Edit, Add refusals, accept → posting → posted.

## Modern Web Guidance used

`DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest …`, run 2026-11-28:
- `dynamic-sort`: move nodes, announce once, focus stays.
- `drag-and-drop`: handle, visible move buttons, drop marker, keyboard grab-move-drop.
- `switch`: Chromium has no native switch, so the existing `Toggle` stays.
- `validate-input-after-interaction`, `accessible-error-announcement`: `:user-invalid` + `aria-invalid`.
- `dialog`: native `<dialog>` + `showModal()`, Esc to close.
- Also from the search results: `forms`, `accessibility`.

## What I couldn't check

- **Impeccable launcher (`context`, `detect`, `shot`):** not run. Its files live under `~/.manta`, which this task said not to read. There is no PRODUCT.md or DESIGN.md in the repo, so I used the existing mockups and the components' source as the design truth.
- **Real fonts:** the mocks fall back to system fonts (Inter isn't bundled in a standalone file), so text widths are approximate.
- **Pointer drag:** not built in the mock.

---

## Hand-off to @dev (renderer slice 3 + the card in slice 4)

**Goal and scope.**
- **In:**
  - the Settings → Research sources section (list, reorder, on/off, Test, Add/Edit/Remove dialogs, notices, states);
  - the "Suggest agents for repeated work" row in Settings → Sessions;
  - the sources line on the profile's Research tab;
  - the suggestion card in ChatPanel under its anchor message;
  - the "Search not sent" tool-row variant.
- **Out:** server work (slices 1, 2 and 4 of the spec), a library browser, agents adding sources from chat.

**Must keep.**
- **Components:** reuse `SettingsRow`, `Toggle`, `Button`, `Pill`/`Tag`, the native `<dialog>` pattern (`StopTaskDialog`), the `DelegateApprovalCard` shell, the "Not started" row, `AgentResearch`'s layout and `UpdateBoxNote`. No new component library.
- **Data:** the list renders the server's order and labels (`research:sources-list`). Secret values never appear anywhere.
- **Offer cards:** render from `agents:suggestions` on chat open and on every `resync`; the live event only triggers that read.
- **Every control reports its outcome** (project rule): saves say "Saved" or why not, and a failed reorder restores the previous order.
- **Wording:** exactly as in the mocks and the spec.

**Nice to have.**
- Animate reorder with an element-scoped view transition (guide `dynamic-sort`), falling back to none.
- Remember the Test query per source for the session.

**Open decisions — do NOT invent; the user decides (recommendations above):** A (Make vs Build), B (notice hide), C (seen = visible), D (switch placement), E (profile line placement).

**Acceptance criteria per state** (each becomes a test):
- **Ideal:**
  - Given the migrated store, the list shows Bookface (YC) search and Bookface posts at positions 1–2, both labelled Private, above the eight defaults in §7 order.
  - The notice contains "Sources moved from the Architect are private; make one public here if you want".
- **Renames / skips:** given `notices` with renames and a skip, the notice shows one line per rename (`packages` → `packages-mine`) and one per skipped id with its sentence.
- **Fresh:** given no user sources, the empty hint and an Add source button appear above the defaults; the count reads "0 of 20 of your own".
- **Loading:** skeleton rows with `aria-busy="true"` until `research:sources-list` answers.
- **Error:**
  - Given `sources-list` rejects, the alert shows "Couldn't load research sources." with the safe sentence and Try again, which re-requests.
  - Given an unknown rpc channel, the older-box note shows.
- **Reorder:**
  - Pressing ↓ on row 1 calls `research:sources-save` with the whole new order, keeps focus on the control and announces "<name> moved to position 2 of N".
  - ↑ is disabled on the first row and ↓ on the last.
  - Given save fails, the order returns to the previous one and the error line shows.
- **On/off:** toggling calls save. A disabled row shows "Off: agents don't search it" ("Off: agents can't search the web" for web).
- **Test:**
  - Test calls `research:sources-test {id, query:"test"}`; the panel shows the running line, then "Works — N results in X s. First: "…"" or the error sentence.
  - A private source shows at most 200 characters of sample.
- **Missing secret:** given `missingSecrets:["YC_TOKEN"]`, the row shows "Missing secret YC_TOKEN" and an Add it in Secrets link.
- **Add / Edit:**
  - Given id `packages`, the Id field shows the built-in-id error after interaction and Save is refused with no call.
  - Given a header value the secret scanner flags, the existing hint shows at that value.
  - Given 20 user sources, Add source is disabled with the limit sentence.
  - Edit can't change the id; unticking Private shows the Outside consequence line.
- **Remove:** only user sources have Remove; the dialog's Remove calls save without that id.
- **Profile:**
  - Given `research.sources` and `library`, the Research tab shows "Searches, in order" with private ones marked, and "N entries · M saved by <agent>", with a link to Settings → Research sources.
  - Given web disabled, Web isn't listed.
  - Given no `research` field, nothing is drawn.
- **Suggestion card:**
  - **Pending, verdict agent:** "Make an agent" is primary and the four answers are present.
  - **Verdict skill:** "Make a skill" is primary.
  - **Accept:** calls `agents:suggestion-act` and shows the sending line. On `posted` it shows the posted line; on `failed` it shows Retry, which calls the act again.
  - **"Not now" / "Don't ask again":** show their resolved lines and post nothing.
  - **Answered elsewhere:** given `{already}`, shows "Already answered on another device: <answer>".
  - After the card is ≥ 50 % visible, `agents:suggestion-seen` is called once.
  - After a reload, the same card renders from the stored offer.
- **Blocked search:** given a tool error carrying the AC-2.8 or AC-2.9b sentence, the row reads "Search not sent · <tool>" with the sentence and never the query text.

**Files:** `docs/screens/research/sources.html`, `docs/screens/research/profile-and-suggestion.html`, `docs/screens/research/decisions.md`. Build with native platform features (dialog, popover, constraint validation) and check against the modern-web-guidance skill (guides listed above).
