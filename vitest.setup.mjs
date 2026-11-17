// Runs in every vitest worker before each test file.
//
// Node ≥ 25 ships its own global `localStorage` / `sessionStorage` (Web Storage), which is
// unusable without `--localstorage-file` (the getter yields `undefined` and warns). Vitest's
// jsdom environment never overrides a global that already exists unless it is on its own
// short key list, and `localStorage` is not on it — so on those Node versions jsdom's working
// Storage is shadowed by Node's broken one and every `localStorage.clear()` throws.
// Point both globals back at the jsdom window's own storage. A no-op outside jsdom tests
// (no `globalThis.jsdom`) and on Node versions that have no global storage at all.
const dom = globalThis.jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => dom.window[key],
    });
  }
}
