// Pure logic for background slash commands (OpenCode V2 v2-next spec, Stage B).
// No React: everything here is unit-tested in backgroundRun.test.ts.
//
//   - which composer text is a valid slash command (the highlight), and when
//     that earns the "Run in background" box;
//   - the highlight overlay's segments (the alignment invariant);
//   - the running / uncertain / failed cards derived from the job store, and
//     the pairing of a running card with its finished (N4) result part;
//   - "Open session": the RPC + window selection, with both outcomes reported.
//
// The contract types below mirror the orchestrator-pinned seams (b-contracts
// P1, P3–P6) exactly; the server slice adds the same names to src/shared.

import type { OpencodeMessage, OpencodePart } from "../shared/types";

// ===== Contract types (P1, P3–P6) =====

/** A command-list entry as the composer reads it (P1: `background` is set only when the box can PROVE it). */
export type SlashCommand = { name: string; background?: true };

/** P3: the N4 part. */
export type BackgroundResultPart = OpencodePart & {
  type: "background-result";
  childSessionId: string;
  jobId?: string;
  state: string;
  name?: string;
  agent?: string;
  text: string;
};

/** P4: the job-record fields the cards read (all optional — absent on old records). */
export type BackgroundJob = {
  id: string;
  name: string;
  parentSessionID: string;
  childSessionID: string | null;
  status: string; // "running" | "paused" | "done" | "failed" | "stopped"
  error: string | null;
  createdAt: number;
  origin?: string;
  completionOwner?: "manta" | "opencode";
  launchState?: "creating" | "submitting" | "running" | "uncertain";
  completionDelivery?: "pending" | "delivered" | "abandoned" | null;
};

/** P5: `opencode:run-command` input widened with `background`, result widened with `{ jobId }`. */
export type RunCommandInput = {
  sessionId: string;
  command: string;
  arguments: string;
  model?: { providerID: string; modelID: string; variant?: string };
  agent?: string;
  attachments?: Array<{ remotePath: string; mime: string; filename: string }>;
  background?: boolean;
};
export type RunCommandResult = void | { jobId: string };

/** P6. */
export type OpenSessionResult =
  | { ok: true; tmuxSession: string; windowIndex: number }
  | { ok: false; error: string };

/** The slice of window.api this feature needs, typed to the contracts. */
export type BackgroundApi = {
  opencodeCommands(opts?: { directory?: string }): Promise<SlashCommand[]>;
  opencodeRunCommand(input: RunCommandInput): Promise<RunCommandResult>;
  delegateOpenSession(input: { jobId: string }): Promise<OpenSessionResult>;
};

/** window.api, typed to the contracts (the shared `Api` gains these members from the server slice). */
export function backgroundApi(): BackgroundApi {
  return window.api as unknown as BackgroundApi;
}

// ===== Highlight + box =====

export type SlashToken = {
  kind: "manta" | "opencode";
  name: string;
  /** Index just past `/name` in the composer text. */
  end: number;
  /** The command always runs in the background (P1): the box shows checked + disabled. */
  alwaysBackground: boolean;
};

/**
 * Is the composer text a valid slash command? Only `/<name>` at index 0
 * counts (a leading space, a mid-text slash, an unknown name do not), and the
 * name must be one of Manta's own commands, an opencode command or a skill.
 * Arguments never matter. Manta's built-ins win over a same-named opencode
 * command, exactly as submit() resolves them.
 */
export function parseSlashToken(
  text: string,
  commands: ReadonlyArray<SlashCommand> | null | undefined,
  mantaNames: ReadonlySet<string>,
): SlashToken | null {
  const m = /^\/(\S+)/.exec(text);
  if (!m) return null;
  const name = m[1];
  const end = m[0].length;
  if (mantaNames.has(name)) return { kind: "manta", name, end, alwaysBackground: false };
  const known = commands?.find((c) => c.name === name);
  if (!known) return null;
  return { kind: "opencode", name, end, alwaysBackground: known.background === true };
}

/** The "Run in background" box is for opencode commands/skills only — never Manta's own. */
export function backgroundBoxVisible(token: SlashToken | null): boolean {
  return token?.kind === "opencode";
}

export const BACKGROUND_LOCKED_TITLE = "This command always runs in the background";
export const BACKGROUND_HELPER_TEXT =
  "runs in its own session, without this chat's history; the result comes back here";

/** Does a send go down the background path? (Locked boxes count as checked.) */
export function backgroundRequested(token: SlashToken | null, checked: boolean): boolean {
  return backgroundBoxVisible(token) && (checked || token!.alwaysBackground);
}

export type OverlaySegment = { text: string; command: boolean };

/**
 * The highlight overlay mirrors the textarea character for character, so its
 * segments must concatenate to EXACTLY the composer text: any drift moves the
 * coloured token off the glyphs it covers. Only the `/name` token is marked.
 */
export function overlaySegments(text: string, token: SlashToken | null): OverlaySegment[] {
  if (!token) return [{ text, command: false }];
  const out: OverlaySegment[] = [{ text: text.slice(0, token.end), command: true }];
  if (token.end < text.length) out.push({ text: text.slice(token.end), command: false });
  return out;
}

/** Split a validated `/name args` text for the run-command call (args are everything after the first whitespace run). */
export function splitSlashText(text: string): { name: string; args: string } | null {
  const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1], args: m[2] ?? "" } : null;
}

// ===== Cards from the job store (N5) =====

export type BackgroundCard =
  | { kind: "running"; key: string; jobId: string; name: string; paused: boolean }
  | { kind: "uncertain"; key: string; jobId: string; name: string }
  | { kind: "failed"; key: string; jobId: string; name: string; error: string }
  | { kind: "settling"; key: string; jobId: string; name: string };

export function isBackgroundResultPart(p: OpencodePart): p is BackgroundResultPart {
  return p.type === "background-result";
}

/** A N4 result message (the background-result part's message, `info.background`). */
export function isBackgroundResultMessage(msg: OpencodeMessage): boolean {
  return (
    (msg.info as { background?: unknown }).background === true ||
    msg.parts.some((p) => p.type === "background-result")
  );
}

export type FinishedKeys = { jobIds: Set<string>; childIds: Set<string> };

/** The jobs a transcript already shows a finished card for — a running card pairs by `jobId`, falling back to `childSessionId`. */
export function collectFinishedKeys(messages: ReadonlyArray<OpencodeMessage> | null | undefined): FinishedKeys {
  const keys: FinishedKeys = { jobIds: new Set(), childIds: new Set() };
  for (const msg of messages ?? []) {
    for (const p of msg.parts) {
      if (!isBackgroundResultPart(p)) continue;
      if (typeof p.jobId === "string" && p.jobId) keys.jobIds.add(p.jobId);
      if (typeof p.childSessionId === "string" && p.childSessionId) keys.childIds.add(p.childSessionId);
    }
  }
  return keys;
}

const LIVE = new Set(["running", "paused"]);

/** Could this job still need a card? Lets the caller skip scanning the transcript when nothing qualifies. */
export function isCardCandidate(job: BackgroundJob, sessionId: string): boolean {
  if (job.parentSessionID !== sessionId) return false;
  if (LIVE.has(job.status)) return true;
  if (job.completionOwner === "manta" && job.completionDelivery === "pending") return true;
  return failedBeforeStart(job);
}

function failedBeforeStart(job: BackgroundJob): boolean {
  if (job.status !== "failed") return false;
  if (job.launchState === "creating" || job.launchState === "submitting") return true;
  return job.origin === "command" && !job.childSessionID;
}

/**
 * The cards under the transcript for `sessionId`, oldest first.
 *  - running / paused → a running card; `launchState:"uncertain"` → the
 *    "couldn't confirm" card (never a spinner);
 *  - a job that failed before its child ran → a failure card with the error;
 *  - a Manta-owned job that finished but whose result is still on its way to
 *    this session → a "finished, result coming" card, so the card does not
 *    vanish for the stretch between the job ending and its result landing;
 *  - any job with a finished (N4) part in the transcript is skipped: the
 *    result card REPLACES it, so a job is never shown twice.
 */
export function deriveBackgroundCards(
  jobs: ReadonlyArray<BackgroundJob>,
  sessionId: string,
  finished: FinishedKeys,
): BackgroundCard[] {
  const cards: BackgroundCard[] = [];
  const mine = jobs
    .filter((j) => j.parentSessionID === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of mine) {
    if (finished.jobIds.has(job.id)) continue;
    if (job.childSessionID && finished.childIds.has(job.childSessionID)) continue;
    const base = { key: job.id, jobId: job.id, name: job.name };
    if (LIVE.has(job.status)) {
      cards.push(
        job.launchState === "uncertain"
          ? { kind: "uncertain", ...base }
          : { kind: "running", ...base, paused: job.status === "paused" },
      );
    } else if (failedBeforeStart(job)) {
      cards.push({ kind: "failed", ...base, error: job.error || "It failed before it started" });
    } else if (job.completionOwner === "manta" && job.completionDelivery === "pending") {
      cards.push({ kind: "settling", ...base });
    }
  }
  return cards;
}

/** Same cards, field for field — lets the caller keep a stable reference while a streaming transcript re-derives them. */
export function sameBackgroundCards(a: ReadonlyArray<BackgroundCard>, b: ReadonlyArray<BackgroundCard>): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i] as Record<string, unknown>;
    const e = c as Record<string, unknown>;
    return Object.keys(e).length === Object.keys(d).length && Object.keys(e).every((k) => e[k] === d[k]);
  });
}

// ===== Finished card copy =====

export type ResultTone = "ok" | "danger" | "neutral";

export function resultTone(state: string): ResultTone {
  if (state === "completed" || state === "done") return "ok";
  if (state === "failed") return "danger";
  return "neutral";
}

export function resultStateLabel(state: string): string {
  if (state === "completed") return "done";
  return state || "finished";
}

/** The card's name: the command ("/review HEAD~1") when known, else the agent, else a plain label. */
export function resultTitle(part: Pick<BackgroundResultPart, "name" | "agent">): string {
  return part.name || (part.agent ? `${part.agent} subagent` : "Background session");
}

// ===== Open session =====

/**
 * Open a background job's session. Both outcomes are visible: the caller gets
 * `{ok:false, error}` for a refusal, a throw or a malformed answer, and
 * `{ok:true}` only after the window has been selected.
 */
export async function openJobSession(
  jobId: string,
  deps: {
    open: (input: { jobId: string }) => Promise<unknown>;
    select: (tmuxSession: string, windowIndex: number) => Promise<void>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let r: unknown;
  try {
    r = await deps.open({ jobId });
  } catch (e) {
    return { ok: false, error: describeError(e, "Couldn't open the session") };
  }
  const res = r as Partial<OpenSessionResult> | null | undefined;
  if (res && res.ok === false) {
    return { ok: false, error: (res as { error?: string }).error || "Couldn't open the session" };
  }
  if (res && res.ok === true && typeof res.tmuxSession === "string" && Number.isInteger(res.windowIndex)) {
    try {
      await deps.select(res.tmuxSession, res.windowIndex as number);
    } catch (e) {
      return { ok: false, error: describeError(e, "Couldn't switch to the session") };
    }
    return { ok: true };
  }
  return { ok: false, error: "Couldn't open the session — the box gave an unexpected answer" };
}

function describeError(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg ? `${fallback}: ${msg}` : fallback;
}
