// permissionAskPump.mjs — the pump's decision for a `permission.asked` event
// under trust mode (chatAutoAllow).
//
// Under trust mode the box answers the ask itself within milliseconds, so the
// user never needs to see it. The stream interpreter turns an ask into
// `permissions` / `attention` frames, so interpreting it BEFORE the auto-reply
// flashed the approval card / red sidebar badge on every tool call (desktop and
// iOS). The pump therefore defers interpretation of `permission.asked` into the
// trust-mode branch and only interprets it when the user really has to act.

/**
 * Should the interpreter see this `permission.asked`?
 *  - trust mode on AND the auto-reply succeeded → NO (nothing for the user to do)
 *  - trust mode off, config unreadable, or the auto-reply failed → YES
 *
 * @param {{ autoAllow: boolean, replied: boolean }} s
 */
export function shouldInterpretPermissionAsk({ autoAllow, replied }) {
  return !(autoAllow === true && replied === true);
}

/**
 * Bounded memory of permission ids the box already auto-answered. opencode's
 * event arrives on BOTH the global and the per-directory stream, so the pump
 * sees each ask twice; without this the second delivery would re-run the reply
 * (which fails — the ask is already answered) and fall through to "interpret
 * it", re-introducing the flash.
 */
export function createAutoAnswerLedger(cap = 500) {
  const ids = new Set();
  return {
    has: (id) => typeof id === "string" && ids.has(id),
    add(id) {
      if (typeof id !== "string" || id.length === 0) return;
      ids.add(id);
      if (ids.size > cap) {
        let drop = ids.size - cap / 2;
        for (const k of ids) {
          if (drop-- <= 0) break;
          ids.delete(k);
        }
      }
    },
  };
}

/**
 * The pump's whole handling of one `permission.asked` event, with every effect
 * injected so it is testable without a live opencode.
 *
 * Order matters: frames (`interpret`) come before the fallback raw `publish`,
 * exactly as when interpretation ran at the top of the pump.
 *
 * @param {{
 *   evt: any,
 *   getConfig: () => Promise<{ chatAutoAllow?: boolean }>,
 *   reply: (a: { requestId: string, reply: "always"|"reject", sessionId?: string }) => Promise<unknown>,
 *   ownsSession?: (sessionId: string) => boolean,
 *   onRejectFailed?: (a: { kind: "permission", requestId: string, sessionId: string, error: unknown }) => void,
 *   interpret: (evt: any) => void,
 *   publish: (evt: any) => void,
 *   push: (evt: any) => void,
 *   ledger: ReturnType<typeof createAutoAnswerLedger>,
 *   warn?: (...a: unknown[]) => void,
 * }} d
 */
export async function handlePermissionAsk(d) {
  const { evt, getConfig, reply, interpret, publish, push, ledger } = d;
  const warn = d.warn ?? (() => {});
  // A background job cannot wait on a person (spec 2026-11-14 A5): an ask in a job's own session or one below it is
  // rejected HERE, before trust mode would approve it. Nothing is interpreted, published or pushed.
  const askSession = evt.properties?.sessionID;
  if (typeof askSession === "string" && d.ownsSession?.(askSession)) {
    const requestId = evt.properties?.id;
    if (typeof requestId === "string" && requestId) {
      if (ledger.has(requestId)) return;
      ledger.add(requestId);
      try {
        await reply({ requestId, reply: "reject", sessionId: askSession });
      } catch (e) {
        warn("[opencode-pump] rejecting a background job's permission ask failed:", e?.message ?? e);
        d.onRejectFailed?.({ kind: "permission", requestId, sessionId: askSession, error: e });
      }
    }
    return;
  }
  let autoAllow = false;
  let replied = false;
  let replyFailed = false;
  try {
    const cfg = await getConfig();
    autoAllow = !!cfg?.chatAutoAllow;
    if (autoAllow) {
      const permId = evt.properties?.id;
      // The same ask arrives on the global AND the per-directory stream. The
      // first delivery to get here owns it (claimed synchronously, before the
      // reply await); the duplicate is suppressed — no second reply (it would
      // 404), no frames, no raw publish.
      if (permId && ledger.has(permId)) return;
      if (permId) ledger.add(permId);
      // Scope the reply to the permission's session directory. Without this the
      // unscoped reply 404s (PermissionNotFoundError) so the turn hung.
      if (permId) {
        try {
          await reply({ requestId: permId, reply: "always", sessionId: evt.properties?.sessionID });
          replied = true;
        } catch (e) {
          warn("[opencode-pump] auto-allow failed:", e?.message ?? e);
          replyFailed = true;
        }
      }
    }
  } catch (e) {
    warn("[opencode-pump] trust-mode config read failed:", e?.message ?? e);
  }
  if (shouldInterpretPermissionAsk({ autoAllow, replied })) interpret(evt);
  // Auto-allow succeeded: nothing for the user to act on — no raw event, no push.
  if (replied) return;
  // Trust off / no id / config unreadable / auto-reply failed: the user approves.
  publish(evt);
  // A failed auto-reply forwarded the event without a push (as before).
  if (replyFailed) return;
  push(evt);
}
