# Resume after limit reset — spec

Status: **approved design, not implemented.** Written 2026-08-17.

Design contract (the visuals): **`docs/screens/usage-resume/mockup.html`**.
Open it alongside this file — it is the source of truth for layout, and it maps
every element onto a primitive that already exists.

---

## 1. Problem

When a subscription provider's usage meter crosses 100%, a toast today offers
**"Keep going at reset"**. It schedules exactly one continuation:

- aimed at **whichever chat pane happened to be focused** when the toast
  appeared — not at the conversation that hit the limit (usage is tracked per
  *provider*, and nothing records which conversation was stopped);
- on **no particular model**, so the resumed turn runs on whatever the server
  considers that session's default — possibly straight back into the exhausted
  provider;
- at a fixed **reset + 60 seconds**, whether or not quota has actually returned;
- as a scheduler job that is **silently dropped** if the box was asleep at that
  minute;
- from renderer-only in-memory state, so the offer **disappears when the app
  closes** and never existed on mobile at all.

None of that is a small bug — the feature targets the wrong conversation by
construction.

## 2. Goal

When a provider limit stops work, the user can see exactly which conversations
were stopped, choose which should carry on unattended, and have that happen when
quota genuinely returns — on the model that was in flight, with the cost stated
up front.

## 3. Scope

The three subscription providers only: **Claude, Codex, Kimi**. A conversation
running on a pay-as-you-go API key never appears anywhere in this feature.

Desktop owns the UI. The record and the resume engine are box-side, so the
native iOS client inherits the behaviour and can add its own surface later
without new plumbing. **Do not build iOS UI in this work.**

---

## 4. Detection

Two independent signals. **Either one enrols a conversation.** They fail in
opposite directions, which is the point: the matcher is precise but only knows
the wordings we have seen, and the correlation is fuzzy but catches everything.

1. **Refusal match.** A turn fails and the error text matches the quota family
   for that conversation's provider. Where the wording names the window
   ("session", "weekly", "Opus"), capture it — that is what tells us which reset
   to wait for.
2. **Meter correlation.** A turn fails and that provider's usage is already at
   its limit. **Re-check that provider's usage immediately on the failure** so
   the decision is not made against a reading up to three minutes old.

### 4.1 Never enrol

| Case | Why not |
|---|---|
| Auth / credential failures | Already classified, and they have their own reconnect prompt. |
| Momentary throttles, overload, 5xx | Clear by themselves in seconds. A row for one is pure noise. |
| Context overflow | Unrelated; compacting is the fix. |
| User aborts, including the queued-message drain abort | Intentional, not a failure. |
| **Credit / overage refusals** | Not a plan window — waiting for a reset does not fix them, so offering a resume would be a lie. |

### 4.2 Strings

Keep every string in **one place**, as data, not scattered through branches.
Adding a wording must be a one-line change.

| Provider | Enrol on | Explicitly NOT quota |
|---|---|---|
| **Claude** | title `usage limit reached`; body `you've hit your session limit` (→ session window), `you've hit your weekly limit` (→ weekly), `you've hit your Opus limit` (→ weekly, Opus-specific) | `temporarily limiting requests`, `not your usage limit`, `usage credits are required` |
| **Codex** | error type `usage_limit_reached`; stream code `insufficient_quota`. The body also carries the reset instant and plan — prefer them over anything inferred. | `rate_limit_exceeded`, `server_is_overloaded`, `slow_down` |
| **Kimi** | `reached your usage limit for this billing cycle` (→ weekly), `reached your usage limit for this period` (→ session), `reached kimi monthly usage limit` (→ monthly) | `engine is currently overloaded`, `receiving too many requests`, `does not have access to` (tier entitlement, not quota) |

Matching is case-insensitive substring. Codex is the only provider with a
structural marker; **Claude and Kimi are vendor copy and will drift** — that is
exactly why signal 2 exists.

### 4.3 Instrumentation

**Log the complete error payload on every failed turn.** The table above cost a
morning of log archaeology; the next unfamiliar refusal must hand us its wording
directly instead.

---

## 5. The record

One box-side, durable record of stopped conversations — the single source for
the indicator, the markers and the modal. That is what makes all three survive
an app restart.

| Field | Purpose |
|---|---|
| workspace + conversation | grouping, and the row identity |
| provider | which meter gates the resume |
| model in flight | pinned on the continuation; shown as the row chip |
| window | session / weekly / monthly, when the refusal named one |
| stopped at | ordering, and the "new since you last looked" badge |
| cached tokens at that moment | the cold-cache cost estimate |
| armed | whether the user chose to resume it |
| attempts | so a permanently-refused conversation stops looping |

Plus one list-level **last-looked** timestamp, stamped when the modal closes.

### 5.1 Lifecycle

- **Created** on detection.
- A repeat refusal for a conversation already listed **updates** that entry.
  Never create a duplicate.
- **Removed** when the conversation runs successfully — whether we resumed it or
  the user did by hand. This is what clears the marker and shrinks the pill.
- **Removed** when the user unchecks it in the modal (an explicit "no"), and
  after a successful resume.

---

## 6. Indicator and markers

- **Sidebar header pill** — the count of stopped conversations **not yet armed**,
  i.e. the ones still asking the user for a decision. Hidden at zero. Opens the
  modal.
- **Row marker** on each stopped conversation, visually distinct from the
  existing idle and attention dots.
- **Precedence:** a pending question or permission request **outranks** the
  stopped marker. It blocks on the user right now; a stopped conversation is
  waiting on a clock.
- Both clear the moment that conversation resumes successfully.

---

## 7. The modal

Opened from the pill, or from the toast's "Keep going at reset". One list across
all providers, grouped by workspace. See the mockup for layout.

- **Row:** checkbox · conversation name · last-activity snippet · model chip ·
  window and reset time · cost.
- **The model chip is not editable.** It shows the model that was in flight and
  that is what sends the continuation. A picker here would let a resume target a
  provider whose quota was never exhausted — a different feature, explicitly out
  of scope.
- **Cost** is zero when the reset falls inside the prompt-cache window,
  otherwise the tokens that will be re-read. Present it as an estimate: it is
  derived from the configured cache lifetime, which the app *mirrors* rather
  than controls.
- Check / uncheck all. Footer shows the selected count and the batch token total.
- **"New" badge** on anything stopped since the modal last closed. Cleared on
  close.
- Reopening shows already-armed rows alongside new ones. **Nothing is ever
  enrolled automatically** — by decision, this feature serves the user who comes
  back and looks.
- A conversation that has resumed **leaves the list**; the sidebar is where you
  watch it run.

---

## 8. The resume

- An armed conversation waits for **its provider's usage to report recovered** —
  *every* window for that provider under its limit, not only the one that was
  named. Waiting on the 5-hour reset while the weekly window is also exhausted
  would resume nothing.
- The batch is triggered by a usage re-check at the reset instant, **not** by a
  fixed offset. The old reset-plus-sixty-seconds is deleted.
- Continuations are sent **a few seconds apart**, not simultaneously — a dozen
  conversations firing at once can re-exhaust a fresh window immediately.
- The continuation is the literal **"Keep going"**, on the pinned model.
- A conversation that is mid-turn **defers until idle** (existing delivery
  behaviour — reuse it, do not write a second one).
- A conversation that comes back **still refused** stays in the list and waits
  for the next check. After a small number of attempts it stops retrying and is
  flagged as needing attention rather than looping forever.
- If the box was asleep past the reset, the batch runs **on wake, however late**
  — by decision.

---

## 9. What this DELETES

This is a replacement, not an addition. The following must be **gone**, not left
beside the new path:

- The single-conversation "Keep going" confirm dialog and its state.
- The fixed `reset + 60s` fire instant.
- The scheduler job this feature created per continuation, and its Undo toast —
  arming now lives in the record. *(The generic scheduler itself stays; it
  serves the AI's own scheduling tool. Only this feature's use of it goes.)*
- The renderer-only assumption that the focused conversation is the one to
  resume.
- Any second definition of "is this conversation stopped" — there is exactly one
  record and one classifier.

"Remind me at reset" (the notify action) is **unchanged and stays.**

---

## 10. Out of scope

- Choosing a different model, or failing over to a provider that still has quota.
- Auto-enrolling conversations stopped after the user last looked.
- iOS picker UI.
- Changing the continuation text, or giving it context about what was
  interrupted.

---

## 11. Risks

- **Vendor copy drifts.** Two of three providers are matched on prose. The meter
  correlation is the backstop; without it a reworded message means silent total
  failure.
- **Correlation can over-enrol.** A turn that failed for an unrelated reason
  while usage sits at 100% will be listed. Acceptable: nothing resumes without
  the user checking it.
- **The cost figure is a prediction**, wrong if the configured cache lifetime
  does not match what the provider is actually sent.
- **A long sleep wakes a lot at once.** Staggering protects the provider; it
  does not stop a dozen conversations resuming hours after they mattered.

---

## 12. Tests

Pure logic only, in the existing suites — no live provider, no real tmux.

- **Classifier:** every positive string per provider enrols and yields the right
  window; every negative string does not; auth strings never match; the
  credits/overage string never enrols.
- **Record lifecycle:** no duplicate on a repeat refusal; cleared on a
  successful run; cleared on uncheck.
- **Modal arithmetic:** selection counts, batch total, cost warm vs cold, the
  "new" badge window boundary.
- **Resume gating:** nothing sent before recovery; every window checked, not
  just the named one; stagger order; refusal re-queues; attempt cap honoured;
  mid-turn deferral.
- **The wiring seam** — indicator → modal → armed record → batch. The equivalent
  path today has no end-to-end test at all, which is precisely why the
  wrong-conversation bug survived.

---

## 13. Open question (does not block implementation)

Confirm which surface displayed *"Usage limit reached / You've hit your session
limit"* — the chat pane, or a Claude Code terminal window. If the latter, the
chat path may carry different wording for the same refusal and the Claude
strings in §4.2 need re-capturing. The meter correlation covers the gap in the
meantime, so this is a refinement, not a blocker.
