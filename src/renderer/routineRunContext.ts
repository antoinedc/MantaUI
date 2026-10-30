// ===== Routine run binding =====
//
// What ChatPanel is told when it is mounted on a routine run's session
// (`routineRun` prop, spec §6.5), and the context that carries it to the
// transcript rows (the routine-prompt bubble, the report card) without
// threading props through Transcript → MessageRow's memo chain.

import { createContext } from "react";
import type { Routine, RoutineRun } from "../shared/routines";

export interface RoutineRunBinding {
  run: RoutineRun;
  routine: Routine;
  prevRunId: string | null;
  nextRunId: string | null;
  onNavigate: (runId: string) => void;
  /** "Keep in sidebar": make the run an ordinary session. */
  onKeep: () => void;
  /** Back to the Routines list. */
  onBack: () => void;
  /** Back to the routine's page, this run selected (the × and the routine-name crumb). */
  onOpenRoutine: () => void;
  /** "Follow up": same as Keep in sidebar — the run becomes an ordinary session to continue in. */
  onFollowUp: () => void;
}

export type RoutineRunContextValue = RoutineRunBinding & { firstUserMessageId: string | null };

export const RoutineRunContext = createContext<RoutineRunContextValue | null>(null);
