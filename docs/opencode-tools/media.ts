// manta-native `media_save` / `media_begin` / `media_show` tools — global
// opencode custom tools.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/media.ts ~/.config/opencode/tools/media.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// These tools are THIN registrars: validate, POST to manta-server
// (127.0.0.1:8787, same box — no SSH hop), and return promptly. The server
// owns the write (into the artifact mailbox), the measurement, and the bus
// events the renderer consumes.
//
// See docs/manta-tools-scheduler.md for the general "manta tools" pattern and
// the inline-media design in the BET-1147 epic.

import { tool } from "@opencode-ai/plugin";
import { join } from "node:path";
import { boxToken, authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one tiny
// local file) so a token rotation never requires an opencode-serve restart.
// MANTA_BOX_TOKEN env overrides for tests/dev.

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MANTA_SERVER}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `manta-server ${res.status}`);
  }
  return json;
}

// POST /api/media and forward the calling session + message id so the server
// can scope the placeholder + artifact sidecar to this turn.
async function mediaCall(action: string, args: Record<string, unknown>, context: any): Promise<any> {
  return call("POST", "/api/media", {
    ...args,
    action,
    sessionID: context.sessionID,
    messageID: context.messageID,
  });
}

export const media_save = tool({
  description: [
    "Put an image or video into the transcript as an inline media artifact.",
    "The model has media in SOME form — either raw base64 bytes it generated,",
    "or a file it already downloaded with curl (pass its local path as",
    "sourcePath). The file is written into the artifact mailbox, measured, and",
    "returned with its real path + dimensions. Exactly one of data or",
    "sourcePath must be supplied. This does NOT display the media itself —",
    "call media_show with the returned path to place it in the transcript.",
  ].join(" "),
  args: {
    data: z
      .string()
      .optional()
      .describe(
        "Base64-encoded bytes of the media (e.g. a generated image). " +
          "Provide exactly one of data or sourcePath, never both.",
      ),
    sourcePath: z
      .string()
      .optional()
      .describe(
        "Local absolute path to an existing media file on this box (e.g. one " +
          "you downloaded with curl). Provide exactly one of data or sourcePath.",
      ),
    filename: z
      .string()
      .optional()
      .describe(
        "A filename (with extension) so the mime/type is known. Required when " +
          "using data; defaulted from sourcePath otherwise.",
      ),
  },
  async execute(args, context) {
    const result = await mediaCall("save", args, context);
    const dims = result.width && result.height ? ` ${result.width}x${result.height}` : "";
    return `Saved media to ${result.path} (${result.mime}${dims}, ${result.size} bytes). Call media_show with that path to put it in the transcript.`;
  },
});

export const media_begin = tool({
  description: [
    "Declare the INTENDED metadata of an image or video BEFORE a slow ",
    "generation completes, so the UI can reserve the exact final space for a ",
    "placeholder. Returns a handle you must keep. After the media is actually ",
    "produced, call media_show with the handle and the file's local path to ",
    "swap the real media in. A media_begin with no following media_show fails ",
    "after 10 minutes.",
  ].join(" "),
  args: {
    kind: z.enum(["image", "video"]).describe("The kind of media being produced."),
    width: z.number().int().positive().optional().describe("Intended width in px (images)."),
    height: z.number().int().positive().optional().describe("Intended height in px (images)."),
    aspectRatio: z
      .number()
      .positive()
      .optional()
      .describe("Intended aspect ratio (width/height) when exact px are unknown."),
    count: z.number().int().positive().optional().describe("Number of items (e.g. a carousel)."),
    title: z.string().optional().describe("Optional short label for the placeholder."),
  },
  async execute(args, context) {
    const result = await mediaCall("begin", args, context);
    return `Placeholder reserved. Handle: ${result.handle}. Keep it and pass it to media_show once the media file exists.`;
  },
});

export const media_show = tool({
  description: [
    "Display an existing image or video file in the transcript, swapping it in ",
    "for a placeholder reserved with media_begin (pass the handle). Accepts a ",
    "LOCAL PATH ONLY — it never fetches a URL and never accepts raw bytes. If ",
    "you have media in another form (base64 or a URL), turn it into a file ",
    "first via media_save or your own curl, then pass that file's path here. ",
    "The path must be inside the user's home directory.",
  ].join(" "),
  args: {
    path: z
      .string()
      .describe(
        "Local absolute (or ~-prefixed) path to the existing file to display, " +
          "e.g. the path returned by media_save.",
      ),
    handle: z
      .string()
      .optional()
      .describe(
        "The handle returned by media_begin, when this media had a reserved " +
          "placeholder. Omit to display a standalone file.",
      ),
    title: z.string().optional().describe("Optional short label."),
  },
  async execute(args, context) {
    const result = await mediaCall("show", args, context);
    const dims = result.width && result.height ? ` ${result.width}x${result.height}` : "";
    return `Displayed ${result.path} (${result.mime}${dims}, ${result.size} bytes) in the transcript.`;
  },
});
