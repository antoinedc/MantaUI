// Harness-only companion plugin (NOT part of the manta pack) for web-guard.e2e.mjs. It registers a `websearch`
// provider that makes ONE plain HTTP request to the e2e's local recording server and selects it as the default, so the
// built-in `websearch` tool has a provider that never leaves the machine and every request it makes is observable.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "harness.web-guard-recorder",
  async setup(ctx: any) {
    const base = process.env.WEB_GUARD_RECORDER_URL
    if (!base) return
    await ctx.websearch.transform((editor: any) => {
      editor.add({
        id: "recorder",
        name: "Recorder",
        execute: async (input: { query: string }) => {
          await fetch(`${base}/provider-search?q=${encodeURIComponent(input.query)}`)
          return [{ url: `${base}/result/1`, title: "Recorded result", content: "recorded", time: {} }]
        },
      })
      editor.default.set("recorder")
    })
  },
})
