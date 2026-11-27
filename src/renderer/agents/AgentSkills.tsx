// ===== The profile's Skills section (Architect v2 §4) =====
//
// Under "Research it relies on" on the Overview: the skills the agent has — name, what it says it is for, how big, and where it came from
// (the origin link, the licence, the installs or stars when the registry told us). Drawn only when the agent has skills. The origin link
// opens through the app and says so when it can't.

import type { AgentSkillInfo } from "../../shared/types";
import { provenanceLine, skillSizeLine } from "../agentSkills";
import { OriginLink } from "../SkillParts";
import { BlockTitle } from "./AgentsParts";

export function AgentSkills({ skills }: { skills: ReadonlyArray<AgentSkillInfo> }) {
  if (skills.length === 0) return null;
  return (
    <section data-testid="profile-skills" aria-label="Skills">
      <BlockTitle>Skills</BlockTitle>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {skills.map((s) => (
          <li key={s.name} className="flex flex-col gap-1 break-words" data-testid="profile-skill">
            <span className="text-body font-medium text-text">{s.name}</span>
            {s.description && <span className="text-label text-text-muted">{s.description}</span>}
            <span className="text-meta text-text-faint">
              {provenanceLine(s.provenance)} · {skillSizeLine(s)}
            </span>
            {s.provenance && (
              <span className="text-meta">
                <OriginLink url={s.provenance.url} errorTestId="profile-skill-link-error" />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
