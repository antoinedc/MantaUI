// ===== The profile's Skills tab (profile v5; Architect v2 §4) =====
//
// The skills the agent has — name, what it says it is for, how big, and where it came from (the origin link, the licence, the installs
// or stars when the registry told us). An agent with none says what a skill is and where one will show up. The origin link opens
// through the app and says so when it can't.

import type { AgentSkillInfo } from "../../shared/types";
import { provenanceLine, skillSizeLine } from "../agentSkills";
import { OriginLink } from "../SkillParts";

export function AgentSkills({ name, skills }: { name: string; skills: ReadonlyArray<AgentSkillInfo> }) {
  return (
    <section data-testid="profile-skills" aria-label="Skills">
      <p className="m-0 mb-4 max-w-[72ch] text-label leading-snug text-text-faint">
        {skills.length === 0
          ? "A skill is a method file, checklist or script the agent reads only when its task needs it."
          : `Method files, checklists and scripts ${name} reads only when its task needs them.`}
      </p>
      {skills.length === 0 ? (
        <p data-testid="skills-empty" className="m-0 max-w-[72ch] text-label leading-snug text-text-faint">
          No skills yet. When a proven skill fits {name}'s job, the Architect proposes it; you'll find it in Needs you, then here.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col border-t border-border-subtle p-0">
          {skills.map((s) => (
            <li key={s.name} className="flex flex-col gap-1 break-words border-b border-border-subtle py-3" data-testid="profile-skill">
              <span className="text-body font-semibold text-text">{s.name}</span>
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
      )}
    </section>
  );
}
