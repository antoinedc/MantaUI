// extra.mjs — running one of the Architect's extra sources (Agents Phase 5A §4.3a).
//
// Trust model: a command source is trusted like a plugin — the user picked the program and approved it on a card; it runs with
// the user's rights. What the server controls is what the MODEL controls, which is only the query text: it is ONE argument
// (never an option, never through a shell). A url source reaches only its literal https origin.

import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { QUERY_TOKEN, QUERY_MAX, SECRET_REF_RE } from "../../shared/architectSources.mjs";
import { ResearchError, fetchFollowing } from "./transport.mjs";

export const COMMAND_TIMEOUT_MS = 60_000;
export const COMMAND_MAX_BYTES = 2 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Is this query safe to hand to an extra source? A sentence refusing it, or null. */
export function queryRefusal(query) {
  if (typeof query !== "string" || query.trim() === "") return "Write a query";
  if (query.length > QUERY_MAX) return `A query can be at most ${QUERY_MAX} characters`;
  if (CONTROL_RE.test(query)) return "A query must be one line of plain text";
  if (query.trimStart().startsWith("-")) return "A query can't start with a dash";
  return null;
}

const refsIn = (value) => [...String(value).matchAll(SECRET_REF_RE)].map((m) => m[1]);

/**
 * Resolve `{secret:NAME}` in a map of strings from `resolve(names)` (Map name → value). A missing secret fails closed.
 * `{ values, used }`: the resolved map and the resolved secret values (for redaction).
 */
export async function resolveMap(map, resolve) {
  const out = {};
  const used = new Set();
  const names = [...new Set(Object.values(map ?? {}).flatMap(refsIn))];
  const found = names.length > 0 ? await resolve(names) : new Map();
  for (const [k, v] of Object.entries(map ?? {})) {
    out[k] = String(v).replace(SECRET_REF_RE, (_m, name) => {
      if (!found.has(name)) throw new ResearchError(`The source's secret ${name} is missing`);
      const value = found.get(name);
      used.add(value);
      return value;
    });
  }
  return { values: out, used };
}

/** Replace every occurrence of every resolved secret value with `[secret]` (a backstop, not a guarantee). */
export function redact(text, used) {
  let out = String(text ?? "");
  for (const value of [...used].filter((v) => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length)) out = out.split(value).join("[secret]");
  return out;
}

/** Where a bare program name is looked for: PATH, then ~/.local/bin and ~/.<name>/bin. */
export function searchDirs(name, { home, pathEnv }) {
  return [...String(pathEnv ?? "").split(":").filter(Boolean), join(home, ".local", "bin"), join(home, `.${name}`, "bin")];
}

async function resolveProgram(program, { home, pathEnv, fs }) {
  if (program.startsWith("/")) return program;
  for (const dir of searchDirs(program, { home, pathEnv })) {
    const file = join(dir, program);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      await fs.access(file, fsConstants.X_OK);
      return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Run a command source for `query`: `{ text }` (secrets redacted) or throws a ResearchError with a fixed sentence — stderr is
 * never returned. No shell: `exec` is execFile-shaped `(file, args, opts) → Promise<{stdout}>`.
 */
export async function runCommandSource(source, query, { home, cwd, pathEnv, lang = "C.UTF-8", exec, fs, resolveSecrets }) {
  const refused = queryRefusal(query);
  if (refused) throw new ResearchError(refused);
  const { values: env, used } = await resolveMap(source.env, resolveSecrets);
  const [program, ...rest] = source.command;
  const file = await resolveProgram(program, { home, pathEnv, fs });
  if (!file) throw new ResearchError("The source's program isn't installed on this box");
  const args = rest.map((w) => (w === QUERY_TOKEN ? query : w));
  const dirs = searchDirs(program, { home, pathEnv });
  await fs.mkdir(cwd, { recursive: true });
  let stdout;
  try {
    ({ stdout } = await exec(file, args, {
      cwd,
      env: { PATH: [...new Set(dirs)].join(":"), HOME: home, LANG: lang, ...env },
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BYTES,
      shell: false,
      windowsHide: true,
    }));
  } catch (e) {
    if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") throw new ResearchError("The source timed out");
    if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new ResearchError("The source returned more than 2 MiB");
    if (e?.code === "ENOENT" || e?.code === "EACCES") throw new ResearchError("The source's program couldn't be started");
    throw new ResearchError(`The source failed (exit ${typeof e?.code === "number" ? e.code : "?"})`);
  }
  return { text: redact(String(stdout ?? ""), used) };
}

/**
 * Call a url source for `query`: the body bytes and content type (secrets redacted by the caller after decoding). Only the
 * source's own origin is reached: a source with any secret follows NO redirect; one without follows only same-origin https
 * redirects (each re-filtered by the transport); a cross-origin redirect is a failure and the second origin is never asked.
 */
export async function runUrlSource(source, query, { hop, resolveSecrets }) {
  const refused = queryRefusal(query);
  if (refused) throw new ResearchError(refused);
  const { values: headers, used } = await resolveMap(source.headers, resolveSecrets);
  const url = source.url.replace(QUERY_TOKEN, encodeURIComponent(query));
  const origin = new URL(url).origin;
  const res = await fetchFollowing(hop, url, {
    headers,
    onRedirect: (from, to) => {
      if (used.size > 0) return "The source redirected, which isn't allowed when it uses secrets";
      let next;
      try {
        next = new URL(to);
      } catch {
        return "The source redirected to an invalid address";
      }
      return next.protocol === "https:" && next.origin === origin ? null : "The source redirected to another site, which isn't allowed";
    },
  });
  return { ...res, used };
}
