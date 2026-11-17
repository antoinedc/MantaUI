// curatorRig.mjs — a fixture for the curator-layer tests (not a test file): a real engine over a real git
// store with every external dep faked (model runner, prompt origins, message reader, repo writer, skills).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKnowledgeEngine } from "./engine.mjs";
import { execGitRunner, makeRepo, tmpDir } from "./testHelpers.mjs";

const fakeLint = async () => ({ preset: { meta: { id: "p" } }, lintSource: async () => ({ messages: [] }) });
export const started = (id) => ({ type: "session.execution.started", data: { sessionID: id } });

/**
 * opts: stored (knowledge settings), projects {name: remote} (default one `widget`), sessions {sid: projectName},
 * runner(args, calls) → {text}|{ok:false, code}, messages {sid: {mid: {role, text}}}, shell {sid: [cmd]},
 * userRefs Set of refs that are user-authored, corrections, repoWriter, skills, globalPath, over (engine deps).
 */
export async function curatorRig({ stored, projects = { widget: "https://github.com/acme/widget.git" }, sessions = { ses_one: "widget" }, runner, messages = {}, shell = {}, userRefs = new Set(), corrections, repoWriter, skills, globalPath, over = {}, briefingText } = {}) {
  const dir = await tmpDir("knowledge-curator-");
  const repos = {};
  for (const [name, remote] of Object.entries(projects)) repos[name] = await makeRepo({ remote });
  const clock = { t: Date.parse("2026-11-17T10:00:00") };
  let cfg = { knowledge: stored };
  const calls = [];
  const notes = [];
  const engine = createKnowledgeEngine({
    dir,
    git: execGitRunner(dir),
    config: { get: async () => cfg, update: async (p) => (cfg = { ...cfg, ...p }) },
    getSession: async (id) => ({ directory: repos[sessions[id]] ?? repos[Object.keys(repos)[0]] }),
    isCtoSession: async () => false,
    loadLint: fakeLint,
    secretValues: () => [],
    fireNotify: async (n) => notes.push(n),
    maintenanceMs: 3_600_000,
    curatorMs: 3_600_000,
    log: () => {},
    listSessionsPage: async () => [],
    now: () => clock.t,
    isUserAuthoredRef: (ref) => userRefs.has(ref),
    readMessages: async ({ sessionID, messageIDs }) => messageIDs.map((id) => ({ id, ...(messages[sessionID]?.[id] ?? {}) })).filter((m) => m.role),
    readShellCommands: async (sid) => shell[sid] ?? null,
    runEphemeral: runner
      ? async (args) => {
          calls.push({ taskClass: args.taskClass, text: args.context.map((b) => b.text).join("\n\n"), args });
          const out = await runner(args, calls);
          if (out?.ok !== false) await args.deps?.reportCost?.({ taskClass: args.taskClass, tier: "mid", model: { providerID: "p", modelID: "m" }, tokens: 4000 });
          return out;
        }
      : undefined,
    corrections,
    repoWriter,
    skills,
    globalAgentsPath: globalPath,
    sessionBriefingText: briefingText,
    ...over,
  });
  await engine.start();
  const slugOf = async (sid) => {
    await engine.observeRaw(started(sid));
    return engine.sessionMap.get(sid)?.slug;
  };
  const note = (slug, sid, kind, text, refs = [`msg:${sid}/msg_1`], extra = {}) => engine.queue.enqueue({ slug, sessionID: sid, origin: "tool", kind, text, refs, ...extra });
  const decide = (decisions) => ({ text: JSON.stringify({ decisions }) });
  return { engine, dir, repos, clock, calls, notes, slugOf, note, decide, getCfg: () => cfg, async writeStore(rel, content) { await mkdir(join(dir, rel, ".."), { recursive: true }); await writeFile(join(dir, rel), content); } };
}
