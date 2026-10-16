// V2 twin of docs/opencode-tools/media.ts → media_save / media_begin /
// media_show. Thin registrars over POST /api/media; the server owns the write,
// the measurement, and the bus events. sessionID + messageID are forwarded so
// the placeholder and artifact scope to this turn.

import { call } from "../lib/server.ts";
import { input, oneOf, posInt, posNum, str } from "../lib/schema.ts";
import type { ToolContext, ToolDef } from "../lib/types.ts";

// POST /api/media and forward the calling session + message id so the server
// can scope the placeholder + artifact sidecar to this turn.
async function mediaCall(
  action: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<any> {
  return call("POST", "/api/media", {
    ...args,
    action,
    sessionID: context.sessionID,
    messageID: context.messageID,
  });
}

export const tools: ToolDef[] = [
  {
    name: "media_save",
    description: [
      "Put an image or video into the transcript as an inline media artifact.",
      "The model has media in SOME form — either raw base64 bytes it generated,",
      "or a file it already downloaded with curl (pass its local path as",
      "sourcePath). The file is written into the artifact mailbox, measured, and",
      "returned with its real path + dimensions. Exactly one of data or",
      "sourcePath must be supplied. This does NOT display the media itself —",
      "call media_show with the returned path to place it in the transcript.",
    ].join(" "),
    input: input(
      {
        data: str(
          "Base64-encoded bytes of the media (e.g. a generated image). " +
            "Provide exactly one of data or sourcePath, never both.",
        ),
        sourcePath: str(
          "Local absolute path to an existing media file on this box (e.g. one " +
            "you downloaded with curl). Provide exactly one of data or sourcePath.",
        ),
        filename: str(
          "A filename (with extension) so the mime/type is known. Required when " +
            "using data; defaulted from sourcePath otherwise.",
        ),
      },
      ["data", "sourcePath", "filename"],
    ),
    async execute(args, context) {
      const result = await mediaCall("save", args, context);
      const dims = result.width && result.height ? ` ${result.width}x${result.height}` : "";
      return `Saved media to ${result.path} (${result.mime}${dims}, ${result.size} bytes). Call media_show with that path to put it in the transcript.`;
    },
  },
  {
    name: "media_begin",
    description: [
      "Declare the INTENDED metadata of an image or video BEFORE a slow ",
      "generation completes, so the UI can reserve the exact final space for a ",
      "placeholder. Returns a handle you must keep. After the media is actually ",
      "produced, call media_show with the handle and the file's local path to ",
      "swap the real media in. A media_begin with no following media_show fails ",
      "after 10 minutes.",
    ].join(" "),
    input: input(
      {
        kind: oneOf(["image", "video"], "The kind of media being produced."),
        width: posInt("Intended width in px (images)."),
        height: posInt("Intended height in px (images)."),
        aspectRatio: posNum("Intended aspect ratio (width/height) when exact px are unknown."),
        count: posInt("Number of items (e.g. a carousel)."),
        title: str("Optional short label for the placeholder."),
      },
      ["width", "height", "aspectRatio", "count", "title"],
    ),
    async execute(args, context) {
      const result = await mediaCall("begin", args, context);
      return `Placeholder reserved. Handle: ${result.handle}. Keep it and pass it to media_show once the media file exists.`;
    },
  },
  {
    name: "media_show",
    description: [
      "Display an existing image or video file in the transcript, swapping it in ",
      "for a placeholder reserved with media_begin (pass the handle). Accepts a ",
      "LOCAL PATH ONLY — it never fetches a URL and never accepts raw bytes. If ",
      "you have media in another form (base64 or a URL), turn it into a file ",
      "first via media_save or your own curl, then pass that file's path here. ",
      "The path must be inside the user's home directory.",
    ].join(" "),
    input: input(
      {
        path: str(
          "Local absolute (or ~-prefixed) path to the existing file to display, " +
            "e.g. the path returned by media_save.",
        ),
        handle: str(
          "The handle returned by media_begin, when this media had a reserved " +
            "placeholder. Omit to display a standalone file.",
        ),
        title: str("Optional short label."),
      },
      ["handle", "title"],
    ),
    async execute(args, context) {
      const result = await mediaCall("show", args, context);
      const dims = result.width && result.height ? ` ${result.width}x${result.height}` : "";
      return `Displayed ${result.path} (${result.mime}${dims}, ${result.size} bytes) in the transcript.`;
    },
  },
];
