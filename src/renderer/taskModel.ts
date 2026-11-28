// The model a task ran on, as the screens name it. The box records it as "provider/model" (`DelegateJob.modelUsed`, `FleetTask.model`);
// people read the catalog's own name ("GPT-6 Sol"), the way the model pickers show it (RoutineEditor's `modelLabel` is the same lookup).

import type { OpencodeModel } from "../shared/types";
import { useModelCatalog } from "./modelCatalog";

/** The catalog's name for `model`, else its model id (the catalog may not have loaded, or may not list it); null when the task has no recorded model. */
export function taskModelLabel(model: string | null | undefined, models: ReadonlyArray<OpencodeModel> | null): string | null {
  if (typeof model !== "string") return null;
  const at = model.indexOf("/");
  if (at <= 0 || at === model.length - 1) return null;
  const providerID = model.slice(0, at);
  const modelID = model.slice(at + 1);
  return models?.find((m) => m.providerID === providerID && m.id === modelID)?.name || modelID;
}

/** `taskModelLabel` over the shared model catalog (re-renders when the catalog arrives). */
export function useTaskModelLabel(model: string | null | undefined): string | null {
  const { models } = useModelCatalog();
  return taskModelLabel(model, models);
}
