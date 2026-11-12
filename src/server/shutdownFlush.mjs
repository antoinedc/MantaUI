// shutdownFlush.mjs — flush write-behind state on SIGTERM / SIGINT, then exit.
//
// Installing a signal listener switches off Node's default "terminate", so the
// handler must end the process itself. It does so with `process.exit(128 + n)`
// rather than re-raising the signal: re-raising only terminates when ours is the
// LAST listener, and any other listener (a library's, a later addition) would
// silently turn a stop into a hang. Runs once however many signals arrive, and
// the flush is capped so a stuck disk cannot hold a shutdown up.

export const SHUTDOWN_FLUSH_CAP_MS = 3_000;
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * @param {{flush: () => Promise<unknown>}} target
 * @param {{proc?: {once: Function}, exit?: (code: number) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, capMs?: number}} [deps]
 */
export function installShutdownFlush(target, { proc = process, exit = (code) => process.exit(code), setTimer = setTimeout, clearTimer = clearTimeout, capMs = SHUTDOWN_FLUSH_CAP_MS } = {}) {
  let ran = false;
  for (const signal of Object.keys(EXIT_CODES)) {
    proc.once(signal, () => {
      if (ran) return;
      ran = true;
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        clearTimer(cap);
        exit(EXIT_CODES[signal]);
      };
      const cap = setTimer(finish, capMs);
      Promise.resolve()
        .then(() => target.flush())
        .then(finish, finish);
    });
  }
}
