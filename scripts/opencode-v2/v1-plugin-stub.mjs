// Stand-in for `@opencode-ai/plugin` (V1) so the V1 tool files in
// docs/opencode-tools/ can be imported under test. `tool()` is the identity and
// `tool.schema` is the REAL zod, so each V1 tool's `args` are genuine zod
// schemas we can convert to JSON Schema and diff against the V2 twins.

import { z } from "zod";

export const tool = Object.assign((definition) => definition, { schema: z });
