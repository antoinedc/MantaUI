// demoExplorer.ts — the `explorer` demo state (docs/screens/explorer): a "manta"
// workspace whose sessions carry file paths in their transcripts, served over the
// pretend filesystem in demoExplorerFs.ts. Nothing here is served in any other
// state, so no other baseline moves.
//
//   peek-range-fix   the mockup's session: Read / Edit tool rows + a reply that
//                    links src/server/peek.mjs:28 and docs/peek-scope.md; running.
//   routines-ui      every path-link state, then the files the viewer can't show.
//   ios-catch-up     idle shell with a pending ask (the sidebar's amber dot).

import type { OpencodeMessage, OpencodeSessionListItem, Project } from "../../shared/types.js";
import { DEMO_T0 } from "./demoFixture.js";
import { DEMO_EXPLORER_CWD, PEEK_MJS } from "./demoExplorerFs.js";

export const EXPLORER_BRANCH = "fix/peek-range";

const SES_PEEK = "ses_ex_peek_range";
const SES_LINKS = "ses_ex_routines_ui";
const SES_IOS = "ses_ex_ios_catch_up";
const SES_BILLING = "ses_ex_billing_webhooks";

/** The session the demo opens on. */
export const EXPLORER_ACTIVE_SESSION = SES_PEEK;

const MIN = 60_000;
const ago = (min: number) => DEMO_T0 - min * MIN;

export const explorerProjects: Project[] = [
  {
    tmuxSession: "manta",
    defaultCwd: "/home/dev/projects/manta",
    attached: true,
    windows: [
      { index: 0, name: "peek-range-fix", active: true, paneCurrentPath: DEMO_EXPLORER_CWD, opencodeSessionId: SES_PEEK },
      { index: 1, name: "routines-ui", active: false, paneCurrentPath: DEMO_EXPLORER_CWD, opencodeSessionId: SES_LINKS },
      { index: 2, name: "ios-catch-up", active: false, paneCurrentPath: DEMO_EXPLORER_CWD, opencodeSessionId: SES_IOS },
    ],
  },
  {
    tmuxSession: "ronda",
    defaultCwd: "/home/dev/projects/ronda",
    attached: true,
    windows: [
      { index: 0, name: "billing-webhooks", active: true, paneCurrentPath: "/home/dev/projects/ronda", opencodeSessionId: SES_BILLING },
    ],
  },
];

export const explorerStatus: Record<
  string,
  Record<number, { running: boolean; subagents: number; attention: boolean; attentionKind?: "idle" | "question" | "permission"; lastMessageAt?: number }>
> = {
  manta: {
    0: { running: true, subagents: 0, attention: false },
    1: { running: false, subagents: 0, attention: false, lastMessageAt: ago(20) },
    2: { running: false, subagents: 0, attention: true, attentionKind: "question" },
  },
  ronda: { 0: { running: false, subagents: 0, attention: false, lastMessageAt: ago(90) } },
};

const sess = (id: string, title: string, directory: string, updatedMinAgo: number): OpencodeSessionListItem => ({
  id,
  slug: title,
  title,
  directory,
  time: { created: ago(updatedMinAgo + 30), updated: ago(updatedMinAgo) },
  model: { id: "claude-opus-4-7", providerID: "anthropic" },
});

export const explorerSessionList: OpencodeSessionListItem[] = [
  sess(SES_PEEK, "peek-range-fix", DEMO_EXPLORER_CWD, 1),
  sess(SES_LINKS, "routines-ui", DEMO_EXPLORER_CWD, 20),
  sess(SES_IOS, "ios-catch-up", DEMO_EXPLORER_CWD, 45),
  sess(SES_BILLING, "billing-webhooks", "/home/dev/projects/ronda", 90),
];

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

const userMsg = (sessionID: string, id: string, text: string, at: number) => ({
  info: { id, sessionID, role: "user", time: { created: at } },
  parts: [{ type: "text", id: `${id}_text`, messageID: id, text }],
});

const assistantInfo = (sessionID: string, id: string, at: number) => ({
  id,
  sessionID,
  role: "assistant",
  modelID: "claude-opus-4-7",
  providerID: "anthropic",
  time: { created: at, completed: at + 20_000 },
});

const textPart = (messageID: string, id: string, text: string) => ({ type: "text", id, messageID, text });

const readOutput = ["<content>", ...PEEK_MJS.trimEnd().split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`), "</content>"].join("\n");

function peekRangeFixMessages(): OpencodeMessage[] {
  const a = "msg_ex_a1";
  return [
    userMsg(SES_PEEK, "msg_ex_u1", "Why does the download 403 for media shown inline?", ago(6)),
    {
      info: assistantInfo(SES_PEEK, a, ago(5)),
      parts: [
        {
          type: "tool",
          id: "prt_ex_read",
          messageID: a,
          tool: "read",
          state: {
            status: "completed",
            title: "src/server/peek.mjs",
            input: { filePath: `${DEMO_EXPLORER_CWD}/src/server/peek.mjs` },
            output: readOutput,
            time: { start: ago(5), end: ago(5) + 400 },
          },
        },
        {
          type: "tool",
          id: "prt_ex_edit",
          messageID: a,
          tool: "edit",
          state: {
            status: "completed",
            title: "src/server/index.mjs",
            input: { filePath: `${DEMO_EXPLORER_CWD}/src/server/index.mjs` },
            metadata: {
              filediff: { additions: 6, deletions: 2 },
              diff: [
                "--- a/src/server/index.mjs",
                "+++ b/src/server/index.mjs",
                "@@ -3924,8 +3924,12 @@",
                " if (req.method === \"GET\" && path === \"/api/download\") {",
                "   const rel = url.searchParams.get(\"path\") ?? \"\";",
                "-  const abs = resolveOutboxPath(rel);",
                "-  if (!abs) return writeJsonError(res, 403, { error: \"outside outbox\" });",
                "+  const abs = resolveHomePath(rel);",
                "+  if (!abs) return writeJsonError(res, 403, { error: \"outside home\" });",
                "+  // Same rule as /api/peek: display and download never disagree.",
                "+  res.setHeader(\"cache-control\", \"no-store\");",
                "+  res.setHeader(\"x-content-type-options\", \"nosniff\");",
                "+  res.setHeader(\"content-disposition\", \"attachment\");",
                "   return streamFile(res, abs, { disposition: \"attachment\" });",
                " }",
              ].join("\n"),
            },
            output: "Edit applied successfully.",
            time: { start: ago(4), end: ago(4) + 300 },
          },
        },
        textPart(
          a,
          "prt_ex_a1_text",
          [
            "The display route and the download route used different scopes. src/server/peek.mjs:28 allows anything under home, while the download handler only allowed the outbox.",
            "",
            "I aligned both and wrote it up in docs/peek-scope.md.",
          ].join("\n"),
        ),
      ],
    },
  ] as unknown as OpencodeMessage[];
}

const LINKS_TEXT = [
  "Confirmed file, relative to the session: src/server/peek.mjs",
  "",
  "With a line / range: src/server/peek.mjs:28 · src/server/peek.mjs:28-34",
  "",
  "Home and absolute: ~/notes/todo.md · /home/dev/projects/manta/AGENTS.md",
  "",
  "A plain link to a file that is not open: docs/peek-scope.md",
  "",
  "Missing, outside home, or not yet confirmed — stays inline code: `src/server/gone.mjs` · `/etc/caddy/Caddyfile`",
  "",
  "A web link, for contrast (unchanged): [mantaui.com/downloads](https://mantaui.com/downloads)",
].join("\n");

const CANT_TEXT = [
  "Each of these exists, and the viewer shows a different outcome for it:",
  "",
  "- ~/downloads/video.mov — too large to preview",
  "- ~/downloads/app.sqlite — a binary file",
  "- ~/notes/old-plan.md — deleted after it was mentioned",
  "- ~/notes/private.txt — the box user can't read it",
  "- ~/notes/flaky.md — the box doesn't answer",
  "- ~/notes/slow.md — still loading",
].join("\n");

function linkStatesMessages(): OpencodeMessage[] {
  return [
    userMsg(SES_LINKS, "msg_ex_lu1", "Show me every kind of path link.", ago(26)),
    { info: assistantInfo(SES_LINKS, "msg_ex_links", ago(25)), parts: [textPart("msg_ex_links", "prt_ex_links", LINKS_TEXT)] },
    userMsg(SES_LINKS, "msg_ex_lu2", "And the files the viewer can't show?", ago(22)),
    { info: assistantInfo(SES_LINKS, "msg_ex_cant", ago(21)), parts: [textPart("msg_ex_cant", "prt_ex_cant", CANT_TEXT)] },
  ] as unknown as OpencodeMessage[];
}

export function explorerTranscript(sessionId: string): OpencodeMessage[] {
  if (sessionId === SES_PEEK) return peekRangeFixMessages();
  if (sessionId === SES_LINKS) return linkStatesMessages();
  return [];
}
