// seatChoice.mjs — typed for the renderer (the "next seat" hint uses the same
// functions as the server's seat resolver). Implementation is the shared .mjs.

export const SEAT_FIELDS: string[];

export interface SeatWindowLike {
  pct: number;
  stale?: boolean;
  active?: boolean;
}

export interface SeatSnapshotLike {
  seatId?: string;
  windows?: SeatWindowLike[];
  exhausted?: boolean;
}

/** `UsageWindow.models` / `scope` — see `windowAppliesToModel`. */
export interface ModelScopedWindowLike {
  scope?: string;
  kind?: string;
  models?: string[];
}

export type KFor = (kind: string) => number | null;

export function normalizeModelToken(v: string): string;
export function windowAppliesToModel(w: ModelScopedWindowLike | null | undefined, model: string | null | undefined): boolean;
export function isWindowActive(w: { active?: boolean } | null | undefined): boolean;
export function activeWindows<W extends { active?: boolean }>(windows: W[] | null | undefined): W[];
export function seatLoad(snap: { windows?: SeatWindowLike[] } | null | undefined): number | null;
export function seatLoadWindow(
  snap: { windows?: Array<SeatWindowLike & { kind?: string }> } | null | undefined,
): { kind: string; pct: number } | null;
export function isSeatExhausted(snap: { exhausted?: boolean } | null | undefined): boolean;
export function nextResetAt(
  snap: { windows?: Array<SeatWindowLike & { resetsAt?: number }> } | null | undefined,
  opts: { nowMs: number; model?: string | null },
): number;
export function soonestResettingSeat<S extends { seatId?: string }>(
  seatSnapshots: S[],
  opts: { nowMs: number; withinMs: number; activeSeatId?: string | null; model?: string | null },
): S | null;
export function leastLoadedSeat<S extends { seatId?: string }>(
  seatSnapshots: S[],
  opts?: { activeSeatId?: string | null },
): S | null;
export function aggregateSnapshot(
  seatSnapshots: object[],
  opts?: { mode?: "auto" | "manual"; activeSeatId?: string | null },
): object | null;

type RankableSnap = { seatId?: string; provider?: string; windows?: any[]; exhausted?: boolean };

export function windowSpanMs(
  w: { kind?: string; startedAt?: number; resetsAt?: number } | null | undefined,
  provider?: string | null,
): number | null;
export function shortWindowState(
  snap: RankableSnap | null | undefined,
  opts: { nowMs: number },
): { state: "running" | "not-started" | "unknown"; roomNow: number | null; nextResetAt: number | null };
export function longWindows<W extends { kind?: string }>(
  snap: { windows?: W[] } | null | undefined,
  opts?: { model?: string | null },
): W[];
export function windowSlackPts(
  snap: RankableSnap | null | undefined,
  w: { resetsAt?: number; pct?: number; stale?: boolean } | null | undefined,
  opts: { nowMs: number; K: number | null | undefined },
): number | null;
export function seatSlackPts(
  snap: RankableSnap | null | undefined,
  opts: { nowMs: number; model?: string | null; kFor?: KFor | null },
): number | null;
export function seatDeadlineAt(snap: RankableSnap | null | undefined, opts: { nowMs: number; model?: string | null }): number | null;
export function legacyMode(snaps: RankableSnap[], opts: { nowMs: number; model?: string | null }): boolean;
export function seatRank(
  snap: RankableSnap,
  opts: { nowMs: number; model?: string | null; kFor?: KFor | null; activeSeatId?: string | null },
): [number, number, number, 0 | 1];
export function bestSeatByRank<S extends RankableSnap>(
  snaps: S[],
  opts: { nowMs: number; model?: string | null; kFor?: KFor | null; activeSeatId?: string | null; tieMs?: number },
): S | null;
