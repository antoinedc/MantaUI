// Static guard for the server's .mjs sources.
//
// WHY THIS EXISTS: `src/server/**` is not covered by either tsconfig
// (tsconfig.node.json includes only src/main + src/preload; tsconfig.web.json
// only the renderer). That left the largest and most operationally critical
// surface in the repo — every .mjs server module — with NO static analysis at
// all. A name that is referenced but never imported is therefore not a build
// error here; it is a ReferenceError thrown at the moment that line first
// runs, in production.
//
// That is not hypothetical. Three instances shipped to main:
//   - `adapterForProviderID` (BET-1536 S4) — crashed every boot.
//   - `loadJobs` in the tool-scan surfaces seam — threw inside a bare catch,
//     so the CTO health card blamed an "unavailable config surface" and the
//     tool scan silently never completed.
//   - `join` in ctoSearchIndex + `WORK_STAGES` in ctoWorkTools — both sitting
//     in error paths, so they were invisible until the error path was taken.
//
// The through-line: each one lived on a rarely-exercised branch (a catch, a
// validation guard, a fallback), which is exactly where tests are thinnest and
// where a crash is most expensive. `no-undef` catches the whole class for
// free, before it runs.
//
// Scope is deliberately narrow — ONE rule, server .mjs only. This is a
// correctness gate, not a style regime; widening it is a separate decision so
// that a formatting debate can never stall a crash-class guard.
export default [
  {
    files: ["src/server/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
        performance: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        MessageChannel: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
        global: "readonly",
        __dirname: "readonly",
      },
    },
    linterOptions: {
      // The repo carries many `eslint-disable no-unused-vars` comments from an
      // earlier config. With only no-undef enabled they report as unused
      // directives; that is noise about a rule we deliberately do not run, not
      // a finding, so it must not fail the gate.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-undef": "error",
    },
  },
];
