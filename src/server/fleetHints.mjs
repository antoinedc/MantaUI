// The Fleet page refetches on the `agentFleet` hint (src/renderer/agents/useAgentsRead.ts). A chat starting or stopping work, or a
// progress report, changes what the page shows without any job event, so those frames become the same hint here — throttled to one
// per window (the first at once, whatever else arrives inside the window as ONE trailing hint). The client debounces on top.

/** Frames that can change a Fleet row: a session's status (running / busy / ask) and a progress report. */
export function isFleetRelevant(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (evt.kind === "progress.updated") return true;
  return evt.kind === "stream" && evt.sub === "windowStatus";
}

export function createFleetHint({ publish, intervalMs = 2000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity;
  let timer = null;
  const fire = () => {
    timer = null;
    last = now();
    publish();
  };
  return {
    observe(evt) {
      if (!isFleetRelevant(evt)) return;
      if (timer) return; // a trailing hint is already on its way
      const wait = last + intervalMs - now();
      if (wait <= 0) {
        fire();
        return;
      }
      timer = setTimer(fire, wait);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
