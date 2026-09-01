// uploadRoute.mjs — POST /api/upload route logic (BET-1460).
//
// Extracted from index.mjs on the projectsRoute.mjs pattern (BET-1458): the
// real route logic is unit-testable here. The 500 catch goes through the
// shared safe-500 writer (safeApiError.mjs) because BOTH consumer surfaces
// render the response's error text to the end user — the desktop chat
// panel's attachment chip (hover text on the red chip) and the iOS composer
// (MantaAPIClient wraps `error` into MantaError.server and shows it). A raw
// fs/stream message would leak absolute UPLOAD_ROOT paths and EPIPE/ENOSPC
// output onto the user's screen; the underlying error is logged server-side
// instead.
//
// Contract:
//   - 200 { path }  — the absolute remote path the bytes were saved to
//   - 400 { error } — "bad session" (session query missing/invalid) or
//                     "missing X-Filename" (no usable filename header)
//   - 500 { error: <UPLOAD_SAFE_500_MESSAGE> } — mkdir/stream failure; the
//     raw error goes to console.warn with an `[api/upload]` tag.
//
// Byte flow: one request per file, raw bytes on the request body, filename +
// batch id in headers (X-Filename percent-encoded, X-Batch-Id optional). No
// multipart parser. Batch dirs are swept by startUploadCleanupPoller
// (src/server/uploads.mjs).

import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { respondSafe500, UPLOAD_SAFE_500_MESSAGE } from "./safeApiError.mjs";

export const SESSION_RE = /^[A-Za-z0-9._-]+$/;
export const BATCH_RE = /^[0-9]{6,20}$/;

export function safeBasename(name) {
  // Strip path separators and control chars; collapse oddballs to "_".
  let n = String(name).replace(/[\x00-\x1f\\/:*?"<>|]/g, "_");
  if (n === "." || n === "..") n = "file";
  if (!n) n = "file";
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

/**
 * @param {object} deps
 * @param {string} deps.uploadRoot  Absolute base dir (~/.manta-uploads).
 *        Stream/fs implementations are injectable for failure-path tests;
 *        defaults are the real node implementations.
 */
export function createUploadHandler({
  uploadRoot,
  mkdirImpl = mkdir,
  pipelineImpl = pipeline,
  createWriteStreamImpl = createWriteStream,
}) {
  return async function handleUpload(req, res, url) {
    const session = url.searchParams.get("session");
    if (!session || !SESSION_RE.test(session)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad session" }));
      return;
    }
    const rawName = req.headers["x-filename"];
    if (typeof rawName !== "string" || !rawName) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing X-Filename" }));
      return;
    }
    let decoded;
    try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
    const filename = safeBasename(decoded);

    const batchHeader = req.headers["x-batch-id"];
    const batch = typeof batchHeader === "string" && BATCH_RE.test(batchHeader)
      ? batchHeader
      : String(Date.now());

    const dir = join(uploadRoot, session, batch);
    const target = join(dir, filename);

    try {
      await mkdirImpl(dir, { recursive: true });
      await pipelineImpl(req, createWriteStreamImpl(target));
    } catch (e) {
      respondSafe500(res, "upload", UPLOAD_SAFE_500_MESSAGE, e);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: target }));
  };
}
