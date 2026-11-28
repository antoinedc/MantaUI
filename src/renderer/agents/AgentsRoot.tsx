// The agent pages' router: the Fleet page, the Needs you page, or one agent's profile. Which one is App state (`AgentsView`), like
// Routines; the Needs-you and task reads come from the App too (the sidebar's number, dot and count come from the same reads), so
// there is one subscription each, not two.

import type { FleetTasks, NeedsYou } from "../../shared/types";
import { AgentProfile } from "./AgentProfile";
import { FleetPage } from "./FleetPage";
import { NeedsYouPage } from "./NeedsYou";
import type { AgentsView } from "./agentsView";
import type { AgentsRead } from "./useAgentsRead";

export function AgentsRoot({
  view,
  setView,
  needs,
  tasks,
}: {
  view: Exclude<AgentsView, null>;
  setView: (v: AgentsView) => void;
  needs: AgentsRead<NeedsYou>;
  tasks: AgentsRead<FleetTasks>;
}) {
  if (view.page === "profile") {
    return <AgentProfile key={view.slug} slug={view.slug} onBack={() => setView({ page: "fleet" })} />;
  }
  if (view.page === "needs") {
    return <NeedsYouPage needs={needs} tasks={tasks} onOpenFleet={() => setView({ page: "fleet" })} />;
  }
  return <FleetPage tasks={tasks} needs={needs} onOpenNeeds={() => setView({ page: "needs" })} />;
}
