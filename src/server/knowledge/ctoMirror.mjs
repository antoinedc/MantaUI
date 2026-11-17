// ctoMirror.mjs — mirror live `cto_fact` proposals into the note queue (spec §5.4).
//
// When the CTO is enabled, every `cto_fact` proposal is ALSO enqueued as a note (`status` /
// `decision` kinds) for the project its free-text key resolves to by the §6.1 rule
// (blackboardImport.createKeyResolver); an unresolvable key is skipped. The CTO blackboard itself is
// unchanged — this only reads the proposal.
//
// WIRING (index.mjs, the `POST /api/cto/facts` handler): after `adaptiveCto.proposeFact(...)` returns
//   if (result.ok) void knowledgeMirror.mirrorCtoFact({ project: body.project, kind: body.kind,
//     statement: body.statement, refs: body.refs, sessionID: body.sessionID }).catch(() => {});
// (fire-and-forget; it never throws and never delays the response).

import { NOTE_TEXT_MAX, NoteRejected } from "./queue.mjs";
import { factKindToNoteKind, mapFactRefs } from "./blackboardImport.mjs";

/**
 * deps: resolver {resolve(key)}, queue {enqueue}, settings {get → {enabled}}, log.
 * `mirrorCtoFact({project, kind, statement, refs, sessionID?})` → `{enqueued:boolean, slug?, id?, reason?}`.
 */
export function createCtoMirror({ resolver, queue, settings, log = console.warn } = {}) {
  if (!resolver || !queue || !settings) throw new Error("createCtoMirror: resolver, queue and settings are required");
  async function mirrorCtoFact({ project, kind, statement, refs, sessionID } = {}) {
    try {
      if (!(await settings.get()).enabled) return { enqueued: false, reason: "disabled" };
      const text = typeof statement === "string" ? statement.replace(/\s+/g, " ").trim().slice(0, NOTE_TEXT_MAX) : "";
      if (!text) return { enqueued: false, reason: "empty statement" };
      const res = await resolver.resolve(project);
      if (!res.ok) return { enqueued: false, reason: res.reason };
      const r = await queue.enqueue({
        slug: res.slug,
        sessionID: typeof sessionID === "string" && sessionID ? sessionID : null,
        origin: "cto",
        kind: factKindToNoteKind(kind),
        text,
        refs: mapFactRefs(refs),
        derived: true,
      });
      return r.accepted ? { enqueued: true, slug: res.slug, id: r.id } : { enqueued: false, slug: res.slug, reason: r.reason };
    } catch (e) {
      if (!(e instanceof NoteRejected)) log("[knowledge] cto mirror failed:", e?.message ?? e);
      return { enqueued: false, reason: e instanceof NoteRejected ? e.reason : "failed" };
    }
  }
  return { mirrorCtoFact };
}
