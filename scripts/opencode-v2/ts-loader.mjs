// Load TypeScript sources under plain Node (any version — CI runs Node 20, which
// has no type stripping). The V2 plugin pack is TypeScript and the V1 tools it
// must mirror are TypeScript; tests transpile both into a throwaway dir with the
// `typescript` package already in devDependencies, rewriting relative `.ts`
// specifiers to `.mjs` and swapping the opencode package imports for stubs.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export function transpile(code) {
  const out = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
  // `./x.ts` → `./x.mjs`; bare `./manta-auth` (V1 style, extensionless) → `./manta-auth.mjs`.
  return out.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(?:\.ts)?(["'])/g,
    (_m, a, spec, c) => `${a}${spec}.mjs${c}`,
  );
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/**
 * Transpile every `.ts` file under `srcDir` into a fresh temp dir, preserving
 * layout. `rewrite(code, file)` may adjust the TS source first (e.g. to stub an
 * import). Returns `{ dir, cleanup }`.
 */
export async function transpileTree(srcDir, { rewrite = (c) => c, files } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "manta-ts-"));
  const sources = files ?? (await walk(srcDir)).filter((f) => f.endsWith(".ts"));
  for (const f of sources) {
    const rel = relative(srcDir, f).replace(/\.ts$/, ".mjs");
    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, transpile(rewrite(await readFile(f, "utf8"), f)));
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
