// inboxCopy.mjs — what a pending-message action's outcome means to the user
// (WS02 server-first, D23/D24; audit C11). Moved from the desktop's
// inboxState.ts: the box writes every sentence and decides whether the text may
// go back into the composer, so desktop and iOS cannot disagree.
//
// Only a `cancelled` outcome proves the message will not be sent, so only it
// may restore text — restoring after `unknown` could make the user send it twice.

export const ATTACHMENTS_NOT_RESTORED = "Attachments weren't restored — re-attach them";
export const SET_DELIVERY_UNCONFIRMED = "Couldn't confirm the change — check the pending list";
export const ALREADY_SENT = "Already sent to the agent";
export const CANCEL_UNCONFIRMED = "Couldn't confirm it was cancelled — it may still be sent";
export const CANCELLED_TEXT_LOST = "Removed from the queue, but its text couldn't be recovered";

/**
 * `opencode:inbox-cancel` result → `{notice, error, restoreText}`.
 * `restore` is the gesture (Edit last = true, × = false).
 */
export function describeInboxCancel(result, { restore } = {}) {
  const wantRestore = restore === true;
  switch (result?.outcome) {
    case "cancelled": {
      const item = result.item;
      if (!item || typeof item !== "object") {
        // The id was not in the box's snapshot, so there is no text to give back.
        return wantRestore
          ? { notice: CANCELLED_TEXT_LOST, error: null, restoreText: null }
          : { notice: null, error: null, restoreText: null };
      }
      const lostFiles = wantRestore && Number(item.attachmentCount) > 0;
      return {
        notice: lostFiles ? ATTACHMENTS_NOT_RESTORED : null,
        error: null,
        restoreText: wantRestore && typeof item.text === "string" ? item.text : null,
      };
    }
    case "delivered":
      return { notice: ALREADY_SENT, error: null, restoreText: null };
    default:
      return { notice: null, error: CANCEL_UNCONFIRMED, restoreText: null };
  }
}

/**
 * `opencode:inbox-set-delivery` result → `{notice, error}`. `changed` needs
 * nothing (the next inbox frame flips the badge); `delivered` is a notice;
 * anything else — `unknown`, or a malformed answer — is an error. Never silent.
 */
export function describeInboxSetDelivery(result) {
  switch (result?.outcome) {
    case "changed":
      return { notice: null, error: null };
    case "delivered":
      return { notice: ALREADY_SENT, error: null };
    default:
      return { notice: null, error: SET_DELIVERY_UNCONFIRMED };
  }
}
