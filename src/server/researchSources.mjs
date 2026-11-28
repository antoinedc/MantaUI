// researchSources.mjs — the box-wide, ordered list of research sources every agent searches (research layer spec
// docs/superpowers/specs/2026-11-28-research-layer.md §6.1, §6.2, §6.6; US1).
//
// ONE store, `~/.manta/research-sources.json` (through `statePath`, atomic writes, one mutex):
//   { version: 1, migration: { architect: "done" | "none" | "pending-strip", at, notices[] }, sources: [row, …] }
// Array order IS the priority. A built-in row carries only `{ id, kind: "builtin", enabled }` (its name and description come from code,
// src/shared/researchSources.mjs); a user row is a source of `src/shared/architectSources.mjs` plus `{ kind: "command" | "url",
// enabled, addedBy, addedAt }`. Validation, credential rules and execution are the existing ones (architectSources.mjs,
// research/extra.mjs): a literal credential is refused at save, `{secret:NAME}` references only. The store never returns a secret value.
//
// The Architect's own `sources:` (Bookface) are migrated ONCE, at boot (`migrate`): parsed against the OLD built-in id set, renamed `-mine`
// when they collide with a new built-in, forced private, validated against the new rules, written first; then the key is stripped from the
// Architect's agent.md (`stripArchitectSources`, a recorded change) — the strip is retried at every boot until it lands, the import never repeats.
//
// Dependency-injected like the other engines. `rows()` / `list()` are lock-free reads (the file is replaced atomically), so an agent
// recompile called from a mutation can read the store it was called for.

import { statePath } from "../shared/paths.mjs";
import { createMutex, writeJsonAtomic } from "./jsonStore.mjs";
import { createSecretScanner, MIN_SECRET_LENGTH } from "./knowledge/secretScan.mjs";
import { readFile, rename, access } from "node:fs/promises";
import {
  validateSource,
  parseSourceList,
  credentialLiterals,
  secretNamesOf,
  CREDENTIAL_HINT,
  BASE_SOURCE_IDS,
  LEGACY_BASE_SOURCE_IDS,
  LEGACY_SOURCES_MAX,
  SOURCES_MAX,
  SOURCE_ID_RE,
} from "../shared/architectSources.mjs";
import { BUILTIN_SOURCES, DEFAULT_ORDER, isBuiltinSourceId, builtinSource, BUILTIN_NOT_REMOVABLE } from "../shared/researchSources.mjs";
import { ResearchError } from "./research/transport.mjs";

export { BUILTIN_SOURCES, DEFAULT_ORDER };
export const TEST_TIMEOUT_MS = 60_000;
export const SAMPLE_CHARS = 200;
const NEW_BUILTIN_IDS = BASE_SOURCE_IDS.filter((id) => id !== "skills");
const RENAME_SUFFIX = "-mine";
const MIGRATED_PRIVATE_NOTICE = "Sources moved from the Architect are private; make one public here if you want";
const COULDNT_CHECK = "Couldn't check the sources for credentials; try again";
const CORRUPT = "The saved research sources file is damaged, so research is paused. Settings → Research sources can start a new list; the damaged file is kept next to it";
const UNREADABLE = "The saved research sources couldn't be read, so research is paused; check the permissions of ~/.manta/research-sources.json";
const WIRE_ONLY_KEYS = ["builtin", "kind", "enabled", "secretRefs", "missingSecrets", "addedBy", "addedAt"];

/**
 * The store can't be read. A ResearchError so the search tools relay its sentence; `safe` lets the outside check relay it too; `rpcStatus`
 * lets the page show it. `kind`: "corrupt" (the file is there but not a sources document) or "unreadable" (it can't be read at all).
 */
class SourcesError extends ResearchError {
  constructor(message, kind) {
    super(message, kind);
    this.kind = kind;
    this.safe = true;
    this.rpcStatus = 500;
  }
}

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const fit = (base, suffix) => `${base.slice(0, 30 - suffix.length).replace(/-+$/, "")}${suffix}`;

/** The id a legacy source takes when its own is a new built-in's: `<id>-mine`, then `-mine-2`, `-mine-3` … Deterministic. */
export function renamedId(id, taken) {
  let candidate = fit(id, RENAME_SUFFIX);
  for (let n = 2; taken.has(candidate); n++) candidate = fit(id, `${RENAME_SUFFIX}-${n}`);
  return candidate;
}

export function createResearchSources({
  file = statePath("research-sources.json"),
  readArchitectSources = async () => ({ found: false }),
  stripArchitectSources = async () => {},
  loadSecrets = async () => [],
  createScanner = createSecretScanner,
  runTest = async () => {
    throw new ResearchError("Testing a source isn't available here");
  },
  testTimeoutMs = TEST_TIMEOUT_MS,
  onChange = async () => {},
  publish = () => {},
  now = Date.now,
  log = console,
} = {}) {
  const mutex = createMutex();
  const stamp = () => new Date(now()).toISOString();

  // ---- the file ----

  /** The raw document. A missing file is the empty store; an unreadable or malformed one THROWS (a mutation never saves over it). */
  async function readDoc() {
    let text;
    try {
      text = await readFile(file, "utf-8");
    } catch (e) {
      if (e?.code === "ENOENT") return { version: 1, migration: {}, sources: [] };
      throw new SourcesError(UNREADABLE, "unreadable");
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new SourcesError(CORRUPT, "corrupt");
    }
    if (!isPlain(doc) || (doc.sources !== undefined && !Array.isArray(doc.sources))) throw new SourcesError(CORRUPT, "corrupt");
    return { version: 1, migration: isPlain(doc.migration) ? doc.migration : {}, sources: doc.sources ?? [] };
  }

  const writeDoc = (doc) => writeJsonAtomic(file, `${JSON.stringify({ version: 1, migration: doc.migration, sources: doc.sources }, null, 2)}\n`, { mode: 0o600 });

  /**
   * The stored rows with every built-in present (FR-011): a missing one is added enabled at its default place — right after the nearest
   * earlier built-in, else before the nearest later one, else at the end. Unknown or malformed rows are dropped.
   */
  function withBuiltins(stored) {
    const out = [];
    const seen = new Set();
    for (const r of stored) {
      if (!isPlain(r) || typeof r.id !== "string" || seen.has(r.id)) continue;
      if (isBuiltinSourceId(r.id)) out.push({ id: r.id, kind: "builtin", enabled: r.enabled !== false });
      else if (r.kind === "command" || r.kind === "url") out.push(r);
      else continue;
      seen.add(r.id);
    }
    for (const id of DEFAULT_ORDER) {
      if (seen.has(id)) continue;
      const at = DEFAULT_ORDER.indexOf(id);
      let index = -1;
      for (let i = at - 1; i >= 0 && index < 0; i--) index = out.findIndex((r) => r.id === DEFAULT_ORDER[i]) + 1 || -1;
      if (index < 0) {
        for (let i = at + 1; i < DEFAULT_ORDER.length && index < 0; i++) index = out.findIndex((r) => r.id === DEFAULT_ORDER[i]);
      }
      out.splice(index < 0 ? out.length : index, 0, { id, kind: "builtin", enabled: true });
      seen.add(id);
    }
    return out;
  }

  /** A stored row as the runtime and the page see it (no secret value exists in a row). */
  function expand(r) {
    if (r.kind === "builtin") {
      const b = builtinSource(r.id);
      return { id: r.id, builtin: true, kind: "builtin", enabled: r.enabled !== false, private: false, name: b.name, description: b.description, addedBy: "builtin" };
    }
    return {
      id: r.id,
      builtin: false,
      kind: r.kind,
      enabled: r.enabled !== false,
      private: r.private !== false,
      name: r.name,
      description: r.description,
      ...(r.command ? { command: r.command } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.env ? { env: r.env } : {}),
      ...(r.headers ? { headers: r.headers } : {}),
      addedBy: r.addedBy ?? "user",
      addedAt: r.addedAt ?? null,
    };
  }

  /**
   * The ordered rows, enabled or not, for the runtime (the search gate, the prompts). A missing file is the defaults; a damaged or unreadable
   * one THROWS a SourcesError (never the defaults: that would turn a web the user switched off, and every source they removed, back on).
   */
  async function rows() {
    return withBuiltins((await readDoc()).sources).map(expand);
  }

  const enabledRows = async () => (await rows()).filter((r) => r.enabled);
  const webEnabled = async () => (await rows()).find((r) => r.id === "web")?.enabled !== false;

  /** The page's read: every row with the secrets it names and the ones Secrets lacks, plus the migration's notices. */
  async function list() {
    let doc;
    try {
      doc = await readDoc();
    } catch (e) {
      if (e instanceof SourcesError) return { sources: [], notices: [], error: e.message };
      throw e;
    }
    let shared = null;
    try {
      shared = new Set((await loadSecrets()).filter((s) => s?.scope === "shared" && typeof s.key === "string").map((s) => s.key));
    } catch {
      shared = null; // display only: unknown reads as "nothing missing"
    }
    const sources = withBuiltins(doc.sources).map(expand).map((s) => {
      const secretRefs = secretNamesOf(s);
      return { ...s, secretRefs, missingSecrets: shared ? secretRefs.filter((n) => !shared.has(n)) : [] };
    });
    return { sources, notices: Array.isArray(doc.migration?.notices) ? [...doc.migration.notices] : [] };
  }

  /** Move the damaged file next to itself as `<file>.corrupt-<time>` (never over an earlier copy), so it can be recovered by hand. */
  async function keepAside() {
    for (let n = 0; ; n++) {
      const target = `${file}.corrupt-${now()}${n > 0 ? `-${n}` : ""}`;
      try {
        await access(target);
      } catch {
        await rename(file, target);
        return;
      }
    }
  }

  // ---- save ----

  const sourceFields = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !WIRE_ONLY_KEYS.includes(k)));

  async function credentialRefusal(sources) {
    let values;
    try {
      values = (await loadSecrets()).map((s) => s?.value).filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
    } catch (e) {
      log.warn?.(`[research] couldn't read the secrets store to check a source: ${e?.message ?? e}`);
      return { error: COULDNT_CHECK };
    }
    let scanner;
    try {
      scanner = createScanner({ secretValues: () => values });
    } catch {
      return { error: COULDNT_CHECK };
    }
    for (const source of sources) {
      for (const text of credentialLiterals(source)) {
        const r = await scanner.scan(text);
        if (r.unavailable) return { error: COULDNT_CHECK };
        if (!r.clean) return { error: `The source "${source.id}" seems to hold a credential. ${CREDENTIAL_HINT}`, id: source.id };
      }
    }
    return null;
  }

  /**
   * `research:sources-save`: the whole ordered list. `{ ok: true }` or `{ ok: false, error, id? }`; nothing is written on a refusal.
   * A built-in row is `{ id, enabled }` (anything else on it is ignored); a user row is a source plus `enabled`. A save clears the
   * migration's notices (the page has shown them).
   */
  async function save(input) {
    const bad = (error, id) => ({ ok: false, error, ...(id ? { id } : {}) });
    if (!isPlain(input) || !Array.isArray(input.sources)) return bad("Send the whole list of sources");
    const given = input.sources;
    if (given.some((r) => !isPlain(r))) return bad("Every source must be a set of key: value lines");
    // a row with a built-in's id is that built-in's row — unless it carries a command or url (a new source taking the id: refused below)
    const isBuiltinRow = (r) => typeof r.id === "string" && isBuiltinSourceId(r.id) && r.command === undefined && r.url === undefined;
    const userRows = given.filter((r) => !isBuiltinRow(r));
    if (userRows.length > SOURCES_MAX) return bad(`At most ${SOURCES_MAX} sources of your own`);
    const builtinIds = given.filter(isBuiltinRow).map((r) => r.id);
    for (const id of DEFAULT_ORDER) if (!builtinIds.includes(id)) return bad(BUILTIN_NOT_REMOVABLE, id);

    return mutex.runExclusive(async () => {
      let doc;
      let damaged = false;
      try {
        doc = await readDoc();
      } catch (e) {
        // a damaged file is replaced only by the user's own save, and then kept aside; one that can't be read at all is never touched
        if (!(e instanceof SourcesError) || e.kind !== "corrupt") return bad(e.message);
        doc = { version: 1, migration: {}, sources: [] };
        damaged = true;
      }
      const before = new Map(doc.sources.filter(isPlain).map((r) => [r.id, r]));
      const next = [];
      const seen = new Set();
      const users = [];
      for (const r of given) {
        if (isBuiltinRow(r)) {
          if (seen.has(r.id)) return bad(`Two sources share the id "${r.id}"`, r.id);
          seen.add(r.id);
          if (r.enabled !== undefined && typeof r.enabled !== "boolean") return bad(`"${r.id}": enabled must be true or false`, r.id);
          next.push({ id: r.id, kind: "builtin", enabled: r.enabled !== false });
          continue;
        }
        const checked = validateSource(sourceFields(r));
        if (!checked.ok) return bad(checked.error, typeof r.id === "string" ? r.id : undefined);
        const s = checked.source;
        if (seen.has(s.id)) return bad(`Two sources share the id "${s.id}"`, s.id);
        seen.add(s.id);
        if (r.enabled !== undefined && typeof r.enabled !== "boolean") return bad(`"${s.id}": enabled must be true or false`, s.id);
        const old = before.get(s.id);
        users.push(s);
        next.push({ ...s, kind: s.command ? "command" : "url", enabled: r.enabled !== false, addedBy: old?.addedBy ?? "user", addedAt: old?.addedAt ?? stamp() });
      }
      const refused = await credentialRefusal(users);
      if (refused) return bad(refused.error, refused.id);
      if (damaged) await keepAside();
      await writeDoc({ migration: { ...doc.migration, notices: [] }, sources: next });
      return { ok: true };
    }).then(async (res) => {
      if (res.ok) await changed();
      return res;
    });
  }

  async function changed() {
    try {
      publish({ kind: "research.sources.updated" });
    } catch {
      /* a hint only */
    }
    try {
      await onChange();
    } catch (e) {
      log.warn?.(`[research] couldn't recompile the agents after the sources changed: ${e?.message ?? e}`);
    }
  }

  // ---- the migration of the Architect's sources (§6.2) ----

  /** Steps a–d for a raw `sources:` value: `{ ok, rows, notices }` or `{ ok:false, error }` (a bug, not data: nothing is written). */
  function importRows(raw, existing) {
    const parsed = parseSourceList(raw, { reservedIds: LEGACY_BASE_SOURCE_IDS, max: LEGACY_SOURCES_MAX });
    const notices = [...parsed.notes];
    const kept = parsed.sources;
    const taken = new Set([...NEW_BUILTIN_IDS, ...kept.map((s) => s.id), ...existing.map((r) => r.id)]);
    const renames = [];
    const migrated = kept.map((s) => {
      let id = s.id;
      if (NEW_BUILTIN_IDS.includes(s.id)) {
        id = renamedId(s.id, taken);
        taken.add(id);
        renames.push(`${s.id} → ${id}`);
      }
      return { ...s, id, private: true }; // forced private, whatever the file said
    });
    if (renames.length > 0) notices.push(`Renamed because a built-in source took the id: ${renames.join(", ")}`);
    if (migrated.length > 0) notices.push(MIGRATED_PRIVATE_NOTICE);
    // the result must pass the NEW rules
    const all = [...migrated, ...existing];
    if (all.length > SOURCES_MAX) return { ok: false, error: `${all.length} sources of your own are over the limit of ${SOURCES_MAX}` };
    const ids = new Set();
    for (const s of migrated) {
      const v = validateSource(s);
      if (!v.ok) return { ok: false, error: v.error };
      if (ids.has(s.id) || !SOURCE_ID_RE.test(s.id)) return { ok: false, error: `Two sources share the id "${s.id}"` };
      ids.add(s.id);
    }
    const at = stamp();
    return { ok: true, notices, rows: migrated.map((s) => ({ ...s, kind: s.command ? "command" : "url", enabled: true, addedBy: "migration", addedAt: at })) };
  }

  /**
   * Run once at boot, idempotent, never throws. Unset → import the Architect's sources (written first), then strip the key from its file;
   * `pending-strip` → only the strip is retried. Returns the state it ends in.
   */
  async function migrate() {
    let changedNow = false;
    let state = null;
    try {
      await mutex.runExclusive(async () => {
        const doc = await readDoc();
        state = doc.migration?.architect ?? null;
        if (state === "done" || state === "none") return;
        if (!state) {
          const arch = await readArchitectSources();
          if (arch?.unreadable) {
            log.warn?.("[research] the Architect's file couldn't be read; its sources are migrated at the next boot");
            return;
          }
          if (!arch?.found) {
            await writeDoc({ ...doc, migration: { architect: "none", at: stamp(), notices: doc.migration?.notices ?? [] } });
            state = "none";
            return;
          }
          const existing = doc.sources.filter((r) => isPlain(r) && (r.kind === "command" || r.kind === "url"));
          const built = importRows(arch.raw, existing);
          if (!built.ok) {
            log.warn?.(`[research] the Architect's sources can't be migrated yet: ${built.error}`);
            return;
          }
          await writeDoc({ migration: { architect: "pending-strip", at: stamp(), notices: built.notices }, sources: [...built.rows, ...doc.sources] });
          doc.migration = { architect: "pending-strip", at: stamp(), notices: built.notices };
          doc.sources = [...built.rows, ...doc.sources];
          state = "pending-strip";
          changedNow = true;
        }
        if (state === "pending-strip") {
          try {
            await stripArchitectSources();
          } catch (e) {
            log.warn?.(`[research] couldn't remove the sources from the Architect's file; retried at the next boot: ${e?.message ?? e}`);
            return;
          }
          await writeDoc({ ...doc, migration: { ...doc.migration, architect: "done" } });
          state = "done";
          changedNow = true;
        }
      });
    } catch (e) {
      log.warn?.(`[research] the sources migration failed: ${e?.message ?? e}`);
    }
    if (changedNow) await changed();
    return { state };
  }

  // ---- test (AC-1.10) ----

  const sentenceOf = (e) => (e instanceof ResearchError ? e.message : "The test failed; try again");

  /**
   * `research:sources-test`: `{ id, query? }` (a saved source) or `{ source }` (the add form's unsaved one). `{ ok:true, ms, count, first?,
   * sample? }` or `{ ok:false, error }`. Nothing is stored; a private source's sample is the first 200 characters of its answer and is never logged.
   */
  async function test(input) {
    const query = typeof input?.query === "string" && input.query.trim() ? input.query : "test";
    let def;
    if (isPlain(input?.source)) {
      const v = validateSource(sourceFields(input.source));
      if (!v.ok) return { ok: false, error: v.error };
      def = expand({ ...v.source, kind: v.source.command ? "command" : "url", enabled: true });
    } else {
      let all;
      try {
        all = await rows();
      } catch (e) {
        return { ok: false, error: sentenceOf(e) };
      }
      def = all.find((r) => r.id === input?.id);
      if (!def) return { ok: false, error: `Unknown source "${typeof input?.id === "string" ? input.id.slice(0, 40) : ""}"` };
    }
    const started = now();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ResearchError("The source timed out")), testTimeoutMs);
      });
      const res = await Promise.race([runTest(def, query), timeout]);
      const ms = Math.max(0, now() - started);
      return {
        ok: true,
        ms,
        count: Number.isInteger(res?.count) ? res.count : 0,
        ...(res?.first ? { first: res.first } : {}),
        ...(!def.builtin && typeof res?.text === "string" ? { sample: res.text.slice(0, SAMPLE_CHARS) } : {}),
      };
    } catch (e) {
      return { ok: false, error: sentenceOf(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { list, rows, enabledRows, webEnabled, save, migrate, test, file };
}
