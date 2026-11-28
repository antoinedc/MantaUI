// One row of a line diff (an added, removed or unchanged line, or the gap between hunks): the change card's diff and the skill file view share it.

import type { DiffRow } from "./agentChange";

export function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === "gap") {
    return (
      <div className="flex whitespace-pre text-text-faint" data-diff="gap">
        <span className="select-none shrink-0 w-3" aria-hidden="true" />
        <span className="flex-1">⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}</span>
      </div>
    );
  }
  const add = row.kind === "add";
  const del = row.kind === "del";
  return (
    <div className={`flex whitespace-pre${add ? " bg-[var(--diff-add)]" : del ? " bg-[var(--diff-del)]" : ""}`} data-diff={row.kind}>
      <span className={`select-none shrink-0 w-3 ${add ? "text-ok" : del ? "text-danger" : "text-text-faint"}`} aria-hidden="true">
        {add ? "+" : del ? "−" : " "}
      </span>
      <span className="flex-1 text-text">{row.text || " "}</span>
    </div>
  );
}
