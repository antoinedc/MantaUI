// The model a task ran on, read off its record: "provider/model", or null when nothing was recorded.
//
// Three places hold it, newest knowledge first: `launch.model` (what the round was actually sent on, the model Auto routing picked
// included), then `requestedModel` / `model` (the one the caller named). A continuation carries `launch.model` forward, so the
// newest round of a task always answers for the task.

const key = (m) => (m && typeof m.providerID === "string" && m.providerID && typeof m.modelID === "string" && m.modelID ? `${m.providerID}/${m.modelID}` : null);
const asKey = (s) => (typeof s === "string" && s.indexOf("/") > 0 && s.indexOf("/") < s.length - 1 ? s : null);

/** @returns {string | null} */
export function jobModelOf(job) {
  return key(job?.launch?.model) ?? asKey(job?.requestedModel) ?? asKey(job?.model) ?? null;
}
