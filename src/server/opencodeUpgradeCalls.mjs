// @ts-check
// The three OpenCode V2 calls the V1 → V2 upgrade makes (upgradeV2.mjs's `deps.v2`),
// as typed client operations over the upgrade's OWN fetch / base URL / password — a
// rehearsal or a test can point it at another opencode, and it never touches
// opencode.mjs's `_setApiBase` state. Kept in its own module so the typed calls fall
// under tsconfig.server.json (upgradeV2.mjs itself is not type-checked).

import { createOcClient } from "./opencodeClient.mjs";
import { withInternalMarker } from "./internalSessionMarker.mjs";

/** @typedef {import("@opencode/client").OpenCodeClient} OpenCodeClient */

/**
 * @param {{ fetchImpl: typeof fetch, opencodeUrl: string, password: () => Promise<string>, home: string }} deps
 *   password is re-read for EVERY request (a file created or rotated mid-upgrade is picked up)
 */
export function createUpgradeV2Calls({ fetchImpl, opencodeUrl, password, home }) {
  const { call } = createOcClient({
    send: async (url, init) =>
      fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${await password()}`).toString("base64")}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    resolveUrl: (pathAndQuery) => `${opencodeUrl}${pathAndQuery}`,
  });

  /**
   * One V2 call bounded by `timeoutMs`. A non-2xx throws `<METHOD> <path> → <status> <body…>` — the
   * message the upgrade UI shows — and `ignoreBody` marks a call whose result is not read.
   * @template T
   * @param {string} method
   * @param {string} path  as it appears in the message (the client builds the real request)
   * @param {(c: OpenCodeClient, o: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<T>} fn
   * @param {{ timeoutMs?: number, ignoreBody?: boolean }} [opts]
   * @returns {Promise<T>}
   */
  const v2Call = (method, path, fn, { timeoutMs = 10_000, ignoreBody = false } = {}) =>
    call(`${method} ${path}`, fn, {
      signal: AbortSignal.timeout(timeoutMs),
      ignoreBody,
      onHttpError: (f) => {
        throw new Error(`${method} ${path} → ${f.status} ${f.text.slice(0, 200)}`);
      },
    });

  return {
    // Capped at 60 s, not a long hold: V2's lazy v1 migration runs inside this request on huge
    // DBs, so a hold can span the whole migration. Aborting at the cap turns each hold into the
    // loop's "alive and busy" delayed failure and lets elapsed/count progress publish between
    // holds; a dead opencode is noticed within a minute. The migration itself is boot-triggered
    // server-side and unaffected by the abort.
    migrationStatus: () => v2Call("GET", "/api/experimental/migration/v1", (c, o) => c.migration.v1.status(o), { timeoutMs: 60_000 }),

    // Only ACTIVE plugins count: a plugin that failed to load still appears in the list.
    pluginIds: async () => {
      const r = await v2Call("GET", "/api/plugin", (c, o) => c.plugin.list({ location: { directory: home } }, o));
      return (r?.data ?? [])
        .filter((/** @type {any} */ p) => typeof p === "string" || !p?.state?.status || p.state.status === "active")
        .map((/** @type {any} */ p) => (typeof p === "string" ? p : p?.id))
        .filter(Boolean);
    },

    // One tiny real turn through the Claude login proves auth + plugins + model routing end to end.
    tinyTurn: async () => {
      /** @type {string|null} */
      let id = null;
      try {
        const created = await v2Call("POST", "/api/session", (c, o) =>
          c.session.create({ location: { directory: home }, model: { providerID: "anthropic", id: "claude-haiku-4-5" }, metadata: withInternalMarker() }, o),
        );
        const sessionID = created.id;
        id = sessionID;
        await v2Call("POST", `/api/session/${sessionID}/prompt`, (c, o) => c.session.prompt({ sessionID, text: "Reply with the single word: ok" }, o), { ignoreBody: true });
        await v2Call("POST", `/api/experimental/session/${sessionID}/wait`, (c, o) => c.session.wait({ sessionID }, o), { timeoutMs: 90_000, ignoreBody: true });
        const msgs = await v2Call("GET", `/api/session/${sessionID}/message?limit=20`, (c, o) => c.message.list({ sessionID, limit: 20 }, o));
        const list = /** @type {any[]} */ (msgs?.data ?? []);
        const reply = list.some((m) => m?.type === "assistant" && Array.isArray(m.content) && m.content.some((/** @type {any} */ c) => c?.type === "text" && c.text));
        return reply ? { ok: true } : { ok: false, error: "the model returned no text" };
      } catch (e) {
        return { ok: false, error: String(/** @type {any} */ (e)?.message ?? e) };
      } finally {
        const doomed = id;
        if (doomed) await v2Call("DELETE", `/api/session/${doomed}`, (c, o) => c.session.remove({ sessionID: doomed }, o), { ignoreBody: true }).catch(() => {});
      }
    },
  };
}
