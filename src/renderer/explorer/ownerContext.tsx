// Who a rendered path link belongs to: the chat session (and its folder) whose
// transcript is being drawn. ChatPanel provides it around its transcript;
// surfaces without an Explorer (CTO pane, routines, drafts) provide nothing, so
// no path links render there (spec §Path links → Ownership).

import { createContext, useContext, type ReactNode } from "react";
import type { ExplorerOwner } from "./types";

export const ExplorerOwnerContext = createContext<ExplorerOwner | null>(null);

export function ExplorerOwnerProvider({ owner, children }: { owner: ExplorerOwner | null; children: ReactNode }) {
  return <ExplorerOwnerContext.Provider value={owner}>{children}</ExplorerOwnerContext.Provider>;
}

export function useExplorerOwner(): ExplorerOwner | null {
  return useContext(ExplorerOwnerContext);
}
