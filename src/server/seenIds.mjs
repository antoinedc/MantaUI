// seenIds.mjs — bounded set of seen event ids, shared by the stream
// interpreter and the push pump.
//
// The SAME opencode event is delivered on both the global stream and the
// per-directory scoped one, so any consumer that reads raw events sees each
// event twice. This filter de-duplicates by event id: `seen(id)` returns true
// iff the id was already recorded (in which case the caller drops the event),
// records it otherwise, and evicts the oldest half once the window exceeds
// `cap` so a long-lived process doesn't grow without bound.
//
// Lifted verbatim from the inline logic that used to live in
// streamInterp.mjs — behaviour is already proven there; this is the shared
// extraction so firePush (src/server/push.mjs) can use the same guard.

export function createSeenIdFilter(cap = 1000) {
  const seen = new Set();
  return {
    /**
     * @param {unknown} id
     * @returns {boolean} true if `id` was already recorded (drop the event);
     *   false if it was new (recorded now) or is not a recordable non-empty
     *   string (never dropped — an event without an id is never swallowed).
     */
    seen(id) {
      if (typeof id !== "string" || id.length === 0) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      if (seen.size > cap) {
        // Drop the oldest half; insertion order is preserved by Set.
        let drop = seen.size - cap / 2;
        for (const key of seen) {
          if (drop-- <= 0) break;
          seen.delete(key);
        }
      }
      return false;
    },
  };
}
