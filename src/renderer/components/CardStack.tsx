// ===== CardStack (BET-783) =====
//
// Presentational home of the pinned card stack that mounts above the composer
// (permission / retry / compaction / delegate-approval / schedules|secrets|
// webhooks / queued / send-error). ChatPanel builds the list of visible
// cards as DATA (`PinnedCardRender[]`) and hands it here; this component runs
// it through the pure `arrangeCards` arbiter and renders the result:
//
//   - blocking tier always above ambient, at most one expanded (the newest),
//     the rest behind an "N more requests" toggle;
//   - ambient tier in fixed priority order, at most two expanded, the rest
//     collapsed into a rollup row that expands in place;
//   - the whole stack capped at 30vh with internal scroll, so the transcript
//     stays the flexible child of the panel.
//
// CardMount wraps every card so mount/unmount stays layout-shift-free.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CardMount } from "./CardMount";
import { arrangeCards, type PinnedCard } from "../chatUtils";

export interface PinnedCardRender extends PinnedCard {
  /** Self-contained card content (already includes its own padding wrapper). */
  render: ReactNode;
}

// One padding recipe for the stack's four toggle/rollup controls ("N more
// requests", the two "Show fewer"s, and the collapsed rollup row) — same
// control in four positions (BET-783 steering). `mx-4` keeps them clear of the
// transcript's 72ch measure; `my-1` gives breathing room against surrounding
// cards.
const TOGGLE_CLS =
  "shrink-0 mx-4 my-1 px-3 py-1 text-meta text-text-faint hover:text-text leading-none";

export function CardStack({ cards, sessionId }: { cards: PinnedCardRender[]; sessionId?: string }) {
  const arranged = useMemo(() => arrangeCards(cards), [cards]);
  const { blocking, blockingMore, ambient, ambientRollup, management } = arranged;
  const blockingList = useMemo(
    () => cards.filter((c) => c.tier === "blocking").sort((a, b) => b.order - a.order),
    [cards],
  );
  const [blockingExpanded, setBlockingExpanded] = useState(false);
  const [ambientExpanded, setAmbientExpanded] = useState(false);
  // Collapse any open rollup on session change — carrying an expanded stack
  // across a session switch would be wrong.
  useEffect(() => {
    setBlockingExpanded(false);
    setAmbientExpanded(false);
  }, [sessionId]);

  const rollupText = (() => {
    const counts = new Map<string, number>();
    for (const c of ambientRollup) {
      const l = c.label ?? c.id;
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([l, n]) => (n > 1 ? `${l} ×${n}` : l))
      .join(" · ");
  })();

  return (
    <div className="shrink-0 flex flex-col">
      {/* Management cards — full height, never capped, never rolled up. */}
      {management.map((c) => (
        <CardMount key={c.id} show k={c.id}>
          {c.render}
        </CardMount>
      ))}
      {/* Capped scroller — blocking + ambient unchanged. */}
      <div className="shrink-0 overflow-y-auto" style={{ maxHeight: "30vh" }}>
      {/* Blocking tier — newest first, at most one expanded. */}
      {blockingList.length > 0 && (
        <div className="mx-auto w-full py-1" style={{ maxWidth: "var(--measure)" }}>
          <div className="space-y-2">
            <CardMount show={blockingList.length > 0} k={blocking?.id ?? "blocking"}>
              <div className="shrink-0 px-4 pt-2">{blocking?.render}</div>
            </CardMount>
            {blockingMore > 0 &&
              (blockingExpanded ? (
                <>
                  <CardMount show k="blocking-more">
                    <div className="shrink-0 px-4 pt-2 space-y-2">
                      {blockingList.slice(1).map((c) => (
                        <div key={c.id}>{c.render}</div>
                      ))}
                    </div>
                  </CardMount>
                  <button
                    type="button"
                    onClick={() => setBlockingExpanded(false)}
                    className={TOGGLE_CLS}
                  >
                    Show fewer
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setBlockingExpanded(true)}
                  className={TOGGLE_CLS}
                >
                  {blockingMore > 1 ? `${blockingMore} more requests` : "1 more request"}{" "}›
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Ambient tier — fixed priority, at most two expanded, rest rolled up. */}
      {ambient.map((c) => (
        <CardMount key={c.id} show k={c.id}>
          {c.render}
        </CardMount>
      ))}
      {ambientRollup.length > 0 &&
        (ambientExpanded ? (
          <>
            {ambientRollup.map((c) => (
              <CardMount key={c.id} show k={c.id}>
                {c.render}
              </CardMount>
            ))}
            <button
              type="button"
              onClick={() => setAmbientExpanded(false)}
              className={TOGGLE_CLS}
            >
              Show fewer
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setAmbientExpanded(true)}
            className={`${TOGGLE_CLS} inline-flex items-center gap-1`}
            title="Show all"
          >
            {rollupText} ›
          </button>
        ))}
      </div>
    </div>
  );
}
