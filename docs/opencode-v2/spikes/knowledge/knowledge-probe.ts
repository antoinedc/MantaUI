// Spike plugin (NOT shipped). Answers shared-knowledge spec §0.1 and §0.2.
//  Q1: an ASYNC `context` hook (awaits 200 ms, then appends a marker system block).
//  Q2: what can a plugin observe about session creation? Dumps the ctx surface and
//      tries ctx.event.subscribe() (the built-in plan plugin does this in-process).
// Writes JSONL to $KNOW_LOG.
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

const out = process.env.KNOW_LOG
const log = (rec: Record<string, unknown>) => out && appendFileSync(out, JSON.stringify({ t: Date.now(), ...rec }) + "\n")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shape = (o: any) => (o && (typeof o === "object" || typeof o === "function") ? Object.keys(o) : typeof o)

export default Plugin.define({
  id: "spike.knowledge",
  async setup(ctx: any) {
    log({ what: "setup", ctxKeys: shape(ctx), sessionKeys: shape(ctx.session), eventKeys: shape(ctx.event), eventSubscribeType: typeof ctx.event?.subscribe, directory: ctx.location?.directory })

    // Q1
    await ctx.session.hook("context", async (event: any) => {
      const started = Date.now()
      log({ what: "context.enter", sessionID: event.sessionID, keys: shape(event), systemLen: event.system?.length })
      await sleep(200)
      event.system.push({ type: "text", text: "SPIKE_ASYNC_MARKER_7f3a (appended after await 200ms)" })
      log({ what: "context.exit", sessionID: event.sessionID, tookMs: Date.now() - started, systemLen: event.system.length })
    })

    // Q2 — try every plausible shape of an event subscription
    const tryEvent = async () => {
      const sub = ctx.event?.subscribe
      if (typeof sub !== "function") return log({ what: "event.subscribe", available: false })
      let res: any
      try {
        res = sub.call(ctx.event)
      } catch (e: any) {
        return log({ what: "event.subscribe", threw: String(e?.message ?? e) })
      }
      log({ what: "event.subscribe", available: true, returnKeys: shape(res), isAsyncIterable: typeof res?.[Symbol.asyncIterator] === "function", isPromise: typeof res?.then === "function" })
      try {
        const it = (await res)
        const iter = typeof it?.[Symbol.asyncIterator] === "function" ? it : res
        if (typeof iter?.[Symbol.asyncIterator] === "function") {
          void (async () => {
            for await (const ev of iter) {
              if (typeof ev?.type === "string" && /^session\.(created|deleted|instructions\.updated|compact)/.test(ev.type)) log({ what: "event", type: ev.type, data: ev.data, keys: shape(ev) })
              else log({ what: "event.other", type: ev?.type })
            }
          })().catch((e) => log({ what: "event.loop.error", msg: String(e?.message ?? e) }))
        }
      } catch (e: any) {
        log({ what: "event.iterate.error", msg: String(e?.message ?? e) })
      }
    }
    await tryEvent()
  },
})
