# A sent message shows in exactly one place

Status: agreed 2026-11-03 · Branch `fix/pending-message-duplicate`

## Problem

Observed 2026-11-03. While the agent was running a long tool call, the user
sent a message with a screenshot. The message then showed up twice:

- **(a)** in the transcript, as an already-sent bubble with only the text — the
  screenshot was missing;
- **(b)** in the Pending card, as "sent after this step", with Wait / × and
  "+1 attachment".

It reached the agent only when the tool call ended.

**Root cause** (session DB evidence: the message id was box-minted, i.e. the
idle path):

- **Wrong send path.** The renderer's `running` flag was false when Enter was
  pressed, so the message took the **idle** `submit` path, not the busy
  `sendWhileBusy` path.
- **Where the copies came from:**
  - The idle path adds an optimistic transcript row (id
    `optimistic-user-<ts>`). That row carries only a text part: attachments
    are never added. This is copy (a).
  - The box, which *was* running, parked the prompt in the session inbox as a
    steer. The card's idle-send hide window (`IDLE_SEND_HIDE_MS`) only hides
    inbox items for ~5 s, so the item then appeared in the card. This is
    copy (b).
- **Nothing links the two.** The optimistic row's id differs from the inbox
  item's id. Its removal is "any canonical user message arrives"
  (`reconcileOptimisticUser`), not "this message arrived".

Why `running` was stale is not proven (a missed status frame or a reconnect
resync). The rule below makes the outcome correct whatever the cause.

## Rule

**A user message the panel sent is shown either in the transcript or in the
Pending card — never both. Whichever place shows it shows its attachments.**

1. **One identity from the start.**
   - The idle prompt path mints the message id client-side, the same way the
     busy path does (`mintMessageId()`), and passes it to `opencodePrompt` as
     `messageID`. The busy path already sends it with its options argument; use
     the same argument and do not send a `delivery`.
   - The optimistic transcript row uses that same id as its `info.id`. It is
     marked as optimistic by a field, not by an id prefix.
   - Slash commands (`opencodeRunCommand`): the box mints their id, so they
     keep today's behaviour (prefix-style placeholder, replaced by any user
     message).
2. **Optimistic row = full message.**
   - The optimistic row includes a `file` part per ready attachment, in the
     same part shape the transcript renders for a canonical user message's
     attachments (see `mapUser` in `src/shared/opencodeV2.mjs`).
   - So a screenshot shows from the first frame.
3. **Transcript hides what the card shows.**
   - The transcript renders `messages` minus any **user** row whose id is in
     the ids of `cardItems`: what the Pending card actually displays.
   - This covers the optimistic row (via rule 1) and any canonical row of a
     still-pending message.
   - During the idle hide window the card does not show the item, so the
     transcript keeps showing it: no flash, no gap.
   - Pure helper in `chatUtils.ts` (`hideCardPendingRows(messages, cardIds)`),
     applied where the transcript list is derived (a `useMemo`), never by
     mutating `messages`.
   - Keep the memo-friendliness rules in AGENTS.md "Transcript row
     memoization": the result is a stable array when nothing is hidden.
4. **Replacement by id.**
   - `reconcileOptimisticUser` drops an optimistic row only when the incoming
     canonical user message has the **same id**.
   - The prefix-based fallback remains only for command placeholders.
   - An unrelated user message (another device, a background result) no longer
     removes a pending placeholder.
5. **Delivery.** When the box delivers the item, it leaves the inbox and the
   canonical message (same id, with its file parts) arrives in the transcript.
   It then shows in exactly one place, with the screenshot.
6. **Failure.** Unchanged: a failed idle send removes the optimistic row (now
   by its minted id) and restores nothing else. Today's error banner stays.

Out of scope:
- why `running` went stale;
- the CTO conversation, which has no inbox card (`inbox: false`).

## Libraries considered

| Need | Chosen | Considered → why not |
|---|---|---|
| Reconcile optimistic vs server state | Own code: a pure helper over data the panel already has | TanStack Query / SWR optimistic updates: the transcript is not fetched through a query cache (it is SSE frames plus targeted refetch), and adopting one is a rewrite far beyond this fix. The `useOptimistic` React hook: same mismatch, since the state outlives a single action. |

## Tests

**Pure helpers (`chatUtils.test.ts`):**
- `hideCardPendingRows`: hides a user row whose id is in the card; keeps one
  that isn't; never hides assistant rows; returns the same array reference when
  nothing is hidden.
- `reconcileOptimisticUser`: removes a same-id optimistic row; keeps a pending
  optimistic row when a different user message arrives; still drops a command
  placeholder on any user message.

**ChatPanel harness** (existing ChatPanel harness/test files):
- **Stale-idle send into a running box.** With `running` false in the
  renderer, send with an attachment, then an `inbox` frame lists the item (same
  minted id). After `IDLE_SEND_HIDE_MS`, assert:
  - no transcript row for it;
  - one card row with "+1 attachment";
  - the prompt call carried a `messageID`.

  Then deliver it (inbox empty, canonical message with a file part): exactly
  one transcript row, showing the attachment.
- **Ordinary idle send.** Optimistic row with attachment shown at once, never
  a card row, replaced by the canonical message of the same id.
