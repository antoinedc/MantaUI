// handoff/jobStore.mjs — a STRICT read of the delegate job store, for decisions that must not be made on missing evidence.
//
// The delegate engine's own `loadJobs` turns an unreadable or malformed file into `[]` (right for a running box: one bad read
// must not stop it). The one-time repair of subagent handoff links cuts a link only when NO job record names the session's
// replacement chain, so "[]" because the file couldn't be parsed would be read as "no job" and cut links it must keep.
// Here an absent file is genuinely empty (nothing was ever launched); anything else that isn't a well-formed store throws.

import { readFileSync } from "node:fs";
import { statePath } from "../../shared/paths.mjs";

/** The same file the delegate engine writes (`statePath("delegate-jobs.json")` in delegate.mjs). */
export const jobStorePath = () => statePath("delegate-jobs.json");

/**
 * @param {string} [path]
 * @returns {any[]} the job records
 * @throws when the file exists but can't be read or isn't `{ jobs: [...] }`
 */
export function readJobsStrict(path = jobStorePath()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) throw new Error(`the job store ${path} is not a { jobs: [] } document`);
  return parsed.jobs;
}
