// Reconcile terminal worker outcomes that may have raced work-control startup
// or transiently failed adoption. Delegate completion delivery remains the
// normal wake path; this small watchdog only repairs the durable work record.

export const CTO_WORK_RECONCILE_INTERVAL_MS = 30_000;
const TERMINAL = new Set(["done", "failed", "stopped"]);

export function createCtoWorkReconciler({
  listJobs,
  recordWorkerOutcome,
  intervalMs = CTO_WORK_RECONCILE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = (message) => console.warn(`[cto-work] ${message}`),
} = {}) {
  if (typeof listJobs !== "function" || typeof recordWorkerOutcome !== "function") {
    throw new TypeError("listJobs and recordWorkerOutcome are required");
  }
  let timer = null;
  let inFlight = null;

  async function tick() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const jobs = await listJobs();
      let reconciled = 0;
      for (const job of jobs ?? []) {
        if (!TERMINAL.has(job?.status) || job?.correlation?.kind !== "work" || typeof job.correlation.workId !== "string") continue;
        try {
          const result = await recordWorkerOutcome(job);
          if (result?.adopted) reconciled += 1;
        } catch (error) {
          onError(`failed to reconcile terminal job ${job?.id ?? "?"}: ${error?.message ?? error}`);
        }
      }
      return { ok: true, reconciled };
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (timer) return { stop, tick };
    void tick().catch((error) => onError(`terminal work scan failed: ${error?.message ?? error}`));
    timer = setIntervalFn(() => {
      void tick().catch((error) => onError(`terminal work scan failed: ${error?.message ?? error}`));
    }, intervalMs);
    timer?.unref?.();
    return { stop, tick };
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, tick, get inFlight() { return inFlight !== null; } };
}
