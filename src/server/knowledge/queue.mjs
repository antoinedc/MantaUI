// queue.mjs — the note queue (spec §5.1, §5.4, §11.4).
//
// `~/.manta/knowledge/.queue/<slug>.jsonl`, one note per line:
//   {v:1, id, at, slug, sessionID, origin: "tool"|"capture"|"cto"|"import",
//    kind, text, refs[], derived: boolean}
//
//   • secret-scanned and REDACTED on enqueue, before any model sees a note;
//   • dedup on enqueue by sha256(kind + normalised text) against the last 30 days
//     (hashes live in state.sqlite `note_hash`, so a consumed note still dedups);
//   • bounded: 500 pending per project; above that the oldest DERIVED notes are
//     dropped first (then the oldest of any kind), and the drop count is reported
//     through `onDrop` (Recent changes shows it).

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../../shared/paths.mjs";
import { createMutex } from "../jsonStore.mjs";
import { newNoteId } from "./ids.mjs";
import { SLUG_RE } from "./identity.mjs";

export const NOTE_KINDS = Object.freeze(["howto", "gotcha", "decision", "preference", "status"]);
export const NOTE_ORIGINS = Object.freeze(["tool", "capture", "cto", "import"]);
export const MAX_PENDING = 500;
export const DEDUP_MS = 30 * 24 * 3600 * 1000;
export const NOTE_TEXT_MAX = 400;
export const NOTE_REFS_MAX = 8;

// §11.4 ref grammar
const REF_PATTERNS = [
  /^msg:[A-Za-z0-9_-]{3,64}\/[A-Za-z0-9_-]{3,64}$/,
  /^part:[A-Za-z0-9_-]{3,64}\/[A-Za-z0-9_-]{3,80}$/,
  /^commit:[0-9a-f]{7,40}$/,
  /^file:\/[^\0\n]{1,500}$/,
  /^pr:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+#\d{1,9}$/,
  /^url:https:\/\/[^\s]{1,500}$/,
  /^page:(?:user|commons|projects)\/[^\0\n]{1,200}$/,
];
export const isValidRef = (ref) => typeof ref === "string" && ref.length <= 600 && REF_PATTERNS.some((re) => re.test(ref));

const normText = (t) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
export const noteHash = (kind, text) => createHash("sha256").update(`${kind}\n${normText(text)}`).digest("hex");

export class NoteRejected extends Error {
  constructor(reason, code = "invalid-note") {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

/** Validate tool/capture input. Throws NoteRejected. Returns `{kind, text, refs}` cleaned. */
export function validateNote({ kind, text, refs }, { origin = "tool" } = {}) {
  if (!NOTE_KINDS.includes(kind)) throw new NoteRejected(`kind must be one of ${NOTE_KINDS.join(", ")}.`);
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (t.length < 1 || t.length > NOTE_TEXT_MAX) throw new NoteRejected(`text must be 1 to ${NOTE_TEXT_MAX} characters.`);
  const list = Array.isArray(refs) ? refs : [];
  const strict = origin === "tool";
  if (strict && (list.length < 1 || list.length > NOTE_REFS_MAX)) throw new NoteRejected(`refs must have 1 to ${NOTE_REFS_MAX} entries.`);
  if (list.length > NOTE_REFS_MAX) throw new NoteRejected(`refs must have at most ${NOTE_REFS_MAX} entries.`);
  for (const r of list) if (!isValidRef(r)) throw new NoteRejected(`Invalid ref "${String(r).slice(0, 60)}" (see the ref grammar: msg:, part:, commit:, file:, pr:, url:, page:).`);
  return { kind, text: t, refs: [...new Set(list)] };
}

/**
 * deps: state, scanner {redact}, now, root (queue dir), onDrop(slug, n), isUserAuthoredRef(ref, {sessionID}) →
 * boolean|Promise (default: never — every note is derived until prompt origins are wired).
 */
export function createQueue({ state, scanner, now = Date.now, root = statePath("knowledge", ".queue"), onDrop, isUserAuthoredRef, newId = newNoteId, maxPending = MAX_PENDING } = {}) {
  const db = state.db;
  const locks = new Map();
  const lockFor = (slug) => {
    let l = locks.get(slug);
    if (!l) locks.set(slug, (l = createMutex()));
    return l;
  };
  // The slug becomes a file name: only the pinned shape is ever allowed to reach the file system.
  const fileFor = (slug) => {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new NoteRejected("Invalid project slug.", "invalid-slug");
    return join(root, `${slug}.jsonl`);
  };

  async function readAll(slug) {
    let raw;
    try {
      raw = await readFile(fileFor(slug), "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line);
        if (n && n.v === 1 && typeof n.id === "string") out.push(n);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }
  async function writeAll(slug, notes) {
    await mkdir(root, { recursive: true });
    const tmp = `${fileFor(slug)}.tmp-${process.pid}`;
    await writeFile(tmp, notes.map((n) => JSON.stringify(n)).join("\n") + (notes.length ? "\n" : ""));
    await rename(tmp, fileFor(slug));
  }

  /**
   * Enqueue one note. Returns `{accepted:true, id}` | `{accepted:false, reason}`
   * (duplicate, scanner unavailable). Validation errors throw NoteRejected.
   */
  function enqueue({ slug, sessionID, origin = "tool", kind, text, refs = [], derived }) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return Promise.reject(new NoteRejected("Invalid project slug.", "invalid-slug"));
    return lockFor(slug).runExclusive(async () => {
      const clean = validateNote({ kind, text, refs }, { origin });
      const red = await scanner.redact(clean.text);
      if (red.unavailable) return { accepted: false, reason: "The secret scanner is unavailable, so the note wasn't kept." };
      // Refs are text too (a `url:` with a token, a `file:` path): each is scanned and a ref with a hit is dropped.
      const keptRefs = [];
      for (const ref of clean.refs) {
        const r = await scanner.redact(ref);
        if (r.unavailable) return { accepted: false, reason: "The secret scanner is unavailable, so the note wasn't kept." };
        if (!(r.redacted > 0) && r.text === ref) keptRefs.push(ref);
      }
      const refsDropped = clean.refs.length - keptRefs.length;
      clean.refs = keptRefs;
      if (refsDropped > 0 && keptRefs.length === 0 && origin === "tool") return { accepted: false, reason: "Every ref contained a secret, so the note wasn't kept." };
      const t = now();
      const hash = noteHash(clean.kind, red.text);
      db.prepare("DELETE FROM note_hash WHERE at < ?").run(t - DEDUP_MS);
      if (db.prepare("SELECT 1 AS x FROM note_hash WHERE hash = ? AND slug = ?").get(hash, slug)) return { accepted: false, reason: "Already noted." };
      let isDerived = derived;
      if (isDerived === undefined) {
        let anyUser = false;
        for (const r of clean.refs) {
          if (await Promise.resolve(isUserAuthoredRef?.(r, { sessionID })).catch(() => false)) {
            anyUser = true;
            break;
          }
        }
        isDerived = !anyUser;
      }
      const note = { v: 1, id: newId(t), at: t, slug, sessionID: sessionID ?? null, origin, kind: clean.kind, text: red.text, refs: clean.refs, derived: !!isDerived };
      const pending = await readAll(slug);
      pending.push(note);
      let dropped = 0;
      while (pending.length > maxPending) {
        let i = pending.findIndex((n) => n.derived);
        if (i < 0) i = 0;
        pending.splice(i, 1);
        dropped++;
      }
      await writeAll(slug, pending);
      db.prepare("INSERT OR REPLACE INTO note_hash (hash, slug, at) VALUES (?, ?, ?)").run(hash, slug, t);
      if (dropped > 0) {
        try {
          await onDrop?.(slug, dropped);
        } catch {
          /* reporting only */
        }
      }
      return { accepted: true, id: note.id, redacted: red.redacted > 0 };
    });
  }

  return {
    enqueue,
    /** Pending notes for a project, oldest first. */
    list: (slug) => readAll(slug),
    async count(slug) {
      return (await readAll(slug)).length;
    },
    /** Remove consumed notes (by id) from the pending file; their hashes keep deduping. */
    consume(slug, ids) {
      const drop = new Set(ids);
      return lockFor(slug).runExclusive(async () => {
        const all = await readAll(slug);
        const keep = all.filter((n) => !drop.has(n.id));
        if (keep.length !== all.length) await writeAll(slug, keep);
        return all.length - keep.length;
      });
    },
    /** Slugs that currently have a queue file. */
    async slugs() {
      try {
        return (await readdir(root)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
      } catch {
        return [];
      }
    },
    /** `{count, lastAt}` for the curator's triggers (≥ 5 notes, or 30 minutes after the last). */
    async stats(slug) {
      const all = await readAll(slug);
      return { count: all.length, lastAt: all.length ? all[all.length - 1].at : null };
    },
  };
}
