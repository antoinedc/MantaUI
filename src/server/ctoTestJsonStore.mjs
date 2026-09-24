// ctoTestJsonStore.mjs — the shared per-test JSON-file store fixture used by
// the CTO control-tool test files (the `mantaControlStore` shape:
// name/path/load/save, a cold `{v:1}` start, atomic-ish writes under the
// sandbox). Extracted because the duplication gate scans every changed file
// pairwise, and the identical fixture body used to live verbatim in two test
// files. (ctoTestStores.mjs is a DIFFERENT shared fixture module — the
// engine's in-memory stores bundle.)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ctoPath } from "./ctoStores.mjs";

let seq = 0;

async function loadJsonFile(file, missingValue) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return missingValue;
    throw error;
  }
}

async function saveJsonFile(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

// makeJsonStoreFixture(scope, label) → {name, path, load, save}
// `scope` namespaces the sandbox subdir (per test file), `label` the file.
export function makeJsonStoreFixture(scope, label) {
  seq += 1;
  const file = join(ctoPath(scope), `${label}-${seq}.json`);
  return {
    name: "manta-control",
    path: file,
    load: () => loadJsonFile(file, { v: 1 }),
    save: (data) => saveJsonFile(file, data),
  };
}

// Per-envelope directory store used by work-control tests. It shares the
// durable work-store shape without copying its read/write implementation into
// each test module.
export function makeWorkStoreFixture(scope, label) {
  seq += 1;
  const dir = ctoPath(scope, `${label}-${seq}`);
  const pathFor = (id) => join(dir, `${id}.json`);
  return {
    name: "work",
    dir,
    pathFor,
    load: (id) => loadJsonFile(pathFor(id), null),
    save: (id, data) => saveJsonFile(pathFor(id), { ...data, v: 1 }),
  };
}
