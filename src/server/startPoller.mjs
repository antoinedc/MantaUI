// Shared periodic-task runner — the poller/sweeper shape that schedule.mjs,
// delegate.mjs and capabilities.mjs each hand-rolled (immediate first tick,
// an inFlight re-entrancy guard, `timer.unref()`, and the sweep function as
// the injected unit). Extracted so a new module (e.g. progress.mjs) does not
// become a fourth copy; existing pollers can be converted one at a time.
//
// The caller's `run` owns its I/O + its clock (injected deps); this wrapper
// owns only the timer discipline: run once immediately, then on a cadence,
// never re-entering an in-flight tick, never keeping the process alive.
export function startPoller(run, { intervalMs, label = "poller", immediate = true } = {}) {
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await run();
    } catch (e) {
      console.warn(`[${label}] tick failed:`, e?.message ?? e);
    } finally {
      inFlight = false;
    }
  };
  if (immediate) void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
