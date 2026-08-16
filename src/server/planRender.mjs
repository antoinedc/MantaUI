// planRender.mjs — publish a single-HTML plan bundle (BET-987).
//
// The server-side orchestration behind the `plan_render` custom tool and the
// `POST /api/plan-render` route. It reads the authored plan HTML bundle (the
// file is UNTRUSTED — confined to the session directory, same approach as
// `readPlanMarkdown` but WITHOUT the `.md` requirement, since the bundle is
// HTML), parses it via `parsePlanBundle`, renders the branded document via
// `renderPlanDoc`, stages the result under `statePath("plan-pages")`, and
// registers it through the EXISTING `servePage.registerPage` subsystem with
// TTL 0 (never expires) under the stable `plan-<shortSessionId>` subdomain.
//
// REUSE ONLY — no second registry, no new store, no duplicated confinement or
// URL building. The URL always comes from `registerPage`.

import { readFile as readFileImpl, mkdir as mkdirImpl, writeFile as writeFileImpl } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { parsePlanBundle, renderPlanDoc } from "./planDoc.mjs";
import { planSubdomain } from "./planPage.mjs";
import { registerPage } from "./servePage.mjs";

// Directory the rendered source HTML is staged into before registerPage copies
// it into the durable pages tree. Goes through statePath() (state-file rule).
function planSrcDir() {
  return statePath("plan-pages");
}

/**
 * Resolve an UNTRUSTED plan file path against the session directory and reject
 * it if the result escapes. Mirrors `readPlanMarkdown`'s confinement approach
 * (resolve + require-inside-root) but does NOT require `.md` — the bundle is
 * an HTML file.
 *
 * @returns {{ ok:true, abs:string }} | {{ ok:false, error:string }}
 */
function confineToSession({ file, sessionDir }) {
  if (
    !sessionDir ||
    typeof sessionDir !== "string" ||
    sessionDir.length === 0
  ) {
    return { ok: false, error: "A session directory is required to read the plan file." };
  }
  if (typeof file !== "string" || file.length === 0) {
    return { ok: false, error: "A plan file path is required." };
  }
  const abs = resolve(sessionDir, file);
  const root = resolve(sessionDir) + sep;
  if (abs !== resolve(sessionDir) && !abs.startsWith(root)) {
    return { ok: false, error: "Plan file path is outside the session directory." };
  }
  return { ok: true, abs };
}

/**
 * Read a single-HTML plan bundle off disk (confined to the session dir), parse
 * + render it, and publish it via the existing serve-page subsystem as a plan
 * page (TTL 0 = never expires). Returns whatever `registerPage` returns — the
 * URL comes from there / `baseUrl`, never hand-built here.
 *
 * @param {{ sessionID?: unknown, file?: unknown, sessionDir?: unknown, ref?: unknown }} input
 * @param {object} [deps]
 * @param {string} [deps.baseUrl]     - the box's published base URL (from
 *                                      publicBaseUrl()); required or the call
 *                                      refuses (no silent-404 URL).
 * @param {Function} [deps.readFile]  - defaults to node:fs/promises readFile.
 * @param {Function} [deps.writeFile] - defaults to node:fs/promises writeFile.
 * @param {Function} [deps.mkdir]     - defaults to node:fs/promises mkdir.
 * @param {Function} [deps.srcDir]    - where the staged HTML is written;
 *                                      defaults to statePath("plan-pages").
 * @param {Function} [deps.register]  - defaults to servePage.registerPage.
 */
export async function publishPlanBundle(
  { sessionID, file, sessionDir, ref },
  {
    baseUrl,
    readFile = readFileImpl,
    writeFile = writeFileImpl,
    mkdir = mkdirImpl,
    srcDir = planSrcDir,
    register = registerPage,
    ...registerDeps
  } = {},
) {
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    return { ok: false, error: "A valid session id is required." };
  }
  const subdomain = planSubdomain(sessionID);
  if (!subdomain) {
    return { ok: false, error: "A valid session id is required to publish a plan page." };
  }
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "This box has no published public hostname (it has not registered with " +
        "the gateway), so a hosted plan page would not be reachable from anywhere. " +
        "Page hosting is unavailable on this box.",
    };
  }

  const confined = confineToSession({ file, sessionDir });
  if (!confined.ok) return confined;

  let text;
  try {
    text = await readFile(confined.abs, "utf8");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  const parsed = parsePlanBundle(text);
  if (!parsed.ok) return parsed;

  const rendered = renderPlanDoc({
    title: parsed.title,
    sections: parsed.sections,
    body: parsed.body,
    ref,
  });
  if (!rendered.ok) return rendered;

  try {
    const srcFile = join(srcDir(), `${subdomain}.html`);
    await mkdir(dirname(srcFile), { recursive: true });
    await writeFile(srcFile, rendered.html);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  const srcFile = join(srcDir(), `${subdomain}.html`);

  return register(
    { subdomain, filePath: srcFile, ttlHours: 0, sessionID },
    { baseUrl, ...registerDeps },
  );
}
