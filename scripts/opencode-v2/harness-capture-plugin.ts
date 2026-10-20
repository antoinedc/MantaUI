// Harness-only companion plugin (NOT shipped). Loaded AFTER the plugins under
// test (copied in as `zz-harness-capture.ts`; hooks run in plugin order, so it
// sees the FINAL outgoing request and the FINAL response each plugin produced).
// Appends one JSONL record per provider HTTP exchange to $MANTA_CAPTURE_FILE.
//
// SAFETY: credentials are never written — `authorization` is reduced to a sha12
// fingerprint and `x-api-key` to a presence flag.
import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12)

export default Plugin.define({
  id: "harness.capture",
  async setup(ctx: any) {
    const out = process.env.MANTA_CAPTURE_FILE
    if (!out) return
    const write = (rec: unknown) => appendFileSync(out, JSON.stringify(rec) + "\n")
    for (const providerID of ["anthropic", "openai"]) {
      await ctx.session.hook(
        "http.request",
        async (event: any) => {
          const req: Request = event.request
          const auth = req.headers.get("authorization") ?? ""
          let body: unknown = null
          try {
            body = JSON.parse(await req.clone().text())
          } catch {
            /* not JSON */
          }
          write({
            t: "request",
            sessionID: event.sessionID,
            kind: event.kind,
            url: req.url,
            method: req.method,
            authSha12: auth.startsWith("Bearer ") ? sha12(auth.slice(7)) : null,
            hasApiKey: req.headers.has("x-api-key"),
            headers: {
              "user-agent": req.headers.get("user-agent"),
              "anthropic-beta": req.headers.get("anthropic-beta"),
              "x-app": req.headers.get("x-app"),
              "anthropic-version": req.headers.get("anthropic-version"),
            },
            body,
          })
        },
        { providerID },
      )
      await ctx.session.hook(
        "http.response",
        async (event: any) => {
          write({ t: "response", sessionID: event.sessionID, kind: event.kind, status: event.response.status })
        },
        { providerID },
      )
    }
  },
})
