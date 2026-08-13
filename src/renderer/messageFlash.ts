export const FLASH_MS = 1200;
export const FLASH_WAIT_MS = 2000;
export const FLASH_POLL_MS = 50;

/**
 * Flash the transcript row for `messageId` once it exists in the DOM.
 *
 * The transcript is virtualised and scrolled smoothly, so the target row is
 * typically NOT mounted when the jump is requested — it appears some frames
 * later as the scroll arrives. We therefore poll for it (immediately, then
 * every FLASH_POLL_MS) and give up after FLASH_WAIT_MS so a messageId that
 * never renders cannot leave a timer running forever.
 *
 * Returns a cancel function; calling it stops any pending wait and removes the
 * class if it was already applied. Calling flashMessageRow again for a
 * different row does NOT cancel a previous one — callers that need that must
 * hold the returned canceller (ChatPanel does).
 */
export function flashMessageRow(
  messageId: string,
  root: ParentNode = document,
): () => void {
  let cancelled = false;
  let removeTimer: number | null = null;
  let pollTimer: number | null = null;
  const deadline = Date.now() + FLASH_WAIT_MS;
  // Escape with CSS.escape where available (Chromium); jsdom ships no CSS.escape,
  // so fall back to the raw id there. Message ids are opaque strings from
  // opencode; today they are selector-safe either way.
  const escapedId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(messageId)
      : messageId;
  const selector = `[data-message-id="${escapedId}"]`;

  const applyFlash = (el: Element) => {
    el.classList.add("manta-message-flash");
    removeTimer = window.setTimeout(() => {
      el.classList.remove("manta-message-flash");
      removeTimer = null;
    }, FLASH_MS);
  };

  const check = () => {
    pollTimer = null;
    if (cancelled) return;
    const el = root.querySelector(selector);
    if (el) {
      applyFlash(el);
      return;
    }
    if (Date.now() >= deadline) return;
    pollTimer = window.setTimeout(check, FLASH_POLL_MS);
  };

  check();

  return () => {
    cancelled = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (removeTimer !== null) clearTimeout(removeTimer);
    root.querySelector(selector)?.classList.remove("manta-message-flash");
  };
}
