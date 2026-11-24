// pdf.mjs — PDF text for research_fetch (Agents Phase 5A follow-up). `unpdf` (MIT, a serverless build of Mozilla's pdf.js,
// no native code) extracts the text inside a worker thread with a hard deadline. Pure transport of bytes → text: the caller
// stores the text like any other source. A refusal is a ResearchError whose message is a sentence for the model.

import { Worker } from "node:worker_threads";
import { ResearchError } from "./transport.mjs";

export const PDF_EXTRACT_TIMEOUT_MS = 30_000;
const MIN_TEXT_CHARS = 20;
const WORKER_URL = new URL("./pdfWorker.mjs", import.meta.url);
export const NO_TEXT_SENTENCE = "This PDF has no text layer (it looks like a scan), so it can't be read; look for an HTML or text version of it";
export const UNREADABLE_PDF_SENTENCE = "That PDF couldn't be read (it may be damaged or password-protected)";
export const SLOW_PDF_SENTENCE = "That PDF took too long to read";

/** Extract `{ title, text, pages }` from PDF bytes. Throws a ResearchError (no text layer, unreadable, too slow). */
export function extractPdfText(bytes, { timeoutMs = PDF_EXTRACT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(WORKER_URL, { workerData: { bytes: new Uint8Array(bytes) }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new ResearchError(SLOW_PDF_SENTENCE, "timeout")), timeoutMs);
    worker.once("message", (m) => {
      if (!m?.ok) return finish(reject, new ResearchError(UNREADABLE_PDF_SENTENCE));
      if (m.text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) return finish(reject, new ResearchError(NO_TEXT_SENTENCE));
      finish(resolve, { title: m.title, text: m.text, pages: m.pages });
    });
    worker.once("error", () => finish(reject, new ResearchError(UNREADABLE_PDF_SENTENCE)));
    worker.once("exit", () => finish(reject, new ResearchError(UNREADABLE_PDF_SENTENCE)));
  });
}
