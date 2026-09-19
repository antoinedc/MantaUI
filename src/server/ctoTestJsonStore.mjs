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

// makeJsonStoreFixture(scope, label) → {name, path, load, save}
// `scope` namespaces the sandbox subdir (per test file), `label` the file.
export function makeJsonStoreFixture(scope, label) {
  seq += 1;
  const file = join(ctoPath(scope), `${label}-${seq}.json`);
  return {
    name: "manta-control",
    path: file,
    load: async () => {
      try {
        return JSON.parse(await readFile(file, "utf-8"));
      } catch (error) {
        if (error.code === "ENOENT") return { v: 1 };
        throw error;
      }
    },
    save: async (data) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2));
    },
  };
}
