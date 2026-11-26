// The agent pages' router: the Fleet page, or one agent's profile. Which one is App state (`AgentsView`), like Routines; the
// Needs-you read comes from the App too (the sidebar badge shows its count), so there is one subscription, not two.

import type { NeedsYou } from "../../shared/types";
import { AgentProfile } from "./AgentProfile";
import { FleetPage } from "./FleetPage";
import type { AgentsView } from "./agentsView";
import type { AgentsRead } from "./useAgentsRead";

export function AgentsRoot({
  view,
  setView,
  needs,
}: {
  view: Exclude<AgentsView, null>;
  setView: (v: AgentsView) => void;
  needs: AgentsRead<NeedsYou>;
}) {
  if (view.page === "profile") {
    return <AgentProfile key={view.slug} slug={view.slug} onBack={() => setView({ page: "fleet" })} />;
  }
  return <FleetPage needs={needs} focus={view.focus} focusNonce={view.nonce} onOpenProfile={(slug) => setView({ page: "profile", slug })} />;
}
