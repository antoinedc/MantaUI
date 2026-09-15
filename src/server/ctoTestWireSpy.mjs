// Shared wire-composition fixture (P3a3 review-fix): the strict duplication
// gate flagged the mirrored recording-transport prologue used by the
// production-composition probes in ctoAdmission.test.mjs and
// ctoBinding.test.mjs. Both drive the REAL opencode.mjs client through
// `_setOcTransport` — the recording spy + cache reset + restore lifecycle is
// the shared part; the route responses stay per-test.
import * as ocModule from "./opencode.mjs";

/**
 * Install a recording transport over the REAL opencode client.
 *
 * @param {({ u: URL, method: string, body: object|null }) => Response} respond
 *        Per-route response handler (return `null`-safe: always return a Response).
 * @returns {{ calls: Array<{method, path, query, body, signal}>, reset: () => void }}
 *          `reset()` restores the previous transport and clears the session
 *          directory cache — call it in the test's `finally`.
 */
export function spyOcWire(respond) {
  const calls = [];
  const prev = ocModule._setOcTransport(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body,
      signal: init.signal,
    });
    return respond({ u, method, body });
  });
  return {
    calls,
    reset: () => {
      ocModule._setOcTransport(prev);
      ocModule._resetSessionDirectoryCache();
    },
  };
}
