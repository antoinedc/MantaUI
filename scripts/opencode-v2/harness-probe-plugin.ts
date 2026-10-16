// Harness-only companion plugin (NOT part of the manta pack). Loaded AFTER the
// manta plugin (it is copied in as `zz-harness-probe.ts`), it records, per
// plugin instance (= per location), the effective tool ids visible once manta
// has registered its tools. The e2e reads the JSONL to prove every tool is
// registered — there is no REST endpoint that lists tools.
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

export default Plugin.define({
  id: "harness.probe",
  async setup(ctx: any) {
    const tools = await ctx.tool.list()
    const out = process.env.MANTA_PROBE_FILE
    if (out) {
      appendFileSync(
        out,
        JSON.stringify({ directory: ctx.location.directory, tools: tools.map((t: any) => t.id) }) + "\n",
      )
    }
  },
})
