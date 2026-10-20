// Every Manta tool, in a stable order. One file per V1 tool file
// (docs/opencode-tools/*.ts) plus todo.ts.

import type { ToolDef } from "../lib/types.ts";
import { tools as ctoFact } from "./cto-fact.ts";
import { tools as cto } from "./cto.ts";
import { tools as ctoVerdict } from "./cto-verdict.ts";
import { tools as delegate } from "./delegate.ts";
import { tools as forgeRules } from "./forge-rules.ts";
import { tools as mantaApp } from "./manta-app.ts";
import { tools as media } from "./media.ts";
import { tools as notify } from "./notify.ts";
import { tools as peers } from "./peers.ts";
import { tools as planRender } from "./plan-render.ts";
import { tools as plugins } from "./plugins.ts";
import { tools as progress } from "./progress.ts";
import { tools as resourceSnapshot } from "./resource-snapshot.ts";
import { tools as schedule } from "./schedule.ts";
import { tools as secrets } from "./secrets.ts";
import { tools as sendFile } from "./send-file.ts";
import { tools as sendToCto } from "./send-to-cto.ts";
import { tools as servePage } from "./serve-page.ts";
import { tools as todo } from "./todo.ts";
import { tools as webhook } from "./webhook.ts";
import { tools as widget } from "./widget.ts";

export const allTools: ToolDef[] = [
  ...ctoFact,
  ...cto,
  ...ctoVerdict,
  ...delegate,
  ...forgeRules,
  ...mantaApp,
  ...media,
  ...notify,
  ...peers,
  ...planRender,
  ...plugins,
  ...progress,
  ...resourceSnapshot,
  ...schedule,
  ...secrets,
  ...sendFile,
  ...sendToCto,
  ...servePage,
  ...todo,
  ...webhook,
  ...widget,
];

// A duplicate name would silently shadow another tool ("a later valid
// registration overrides the same effective tool name") — fail at load instead.
const seen = new Set<string>();
for (const t of allTools) {
  if (seen.has(t.name)) throw new Error(`duplicate manta tool name: ${t.name}`);
  seen.add(t.name);
}
