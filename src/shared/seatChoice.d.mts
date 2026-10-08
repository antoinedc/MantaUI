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

export function isWindowActive(w: { active?: boolean } | null | undefined): boolean;
export function activeWindows<W extends { active?: boolean }>(windows: W[] | null | undefined): W[];
export function seatLoad(snap: { windows?: SeatWindowLike[] } | null | undefined): number | null;
export function isSeatExhausted(snap: { exhausted?: boolean } | null | undefined): boolean;
export function leastLoadedSeat<S extends { seatId?: string }>(
  seatSnapshots: S[],
  opts?: { activeSeatId?: string | null },
): S | null;
export function aggregateSnapshot(
  seatSnapshots: object[],
  opts?: { mode?: "auto" | "manual"; activeSeatId?: string | null },
): object | null;
