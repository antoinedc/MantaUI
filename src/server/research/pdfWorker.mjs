// pdfWorker.mjs — the worker thread behind `extractPdfText` (pdf.mjs). PDF parsing is CPU work on bytes from the internet:
// it runs here so a heavy or hostile file can neither freeze manta-server's event loop nor outlive its deadline (the parent
// terminates this thread). Answers one message: { ok: true, text, title, pages } or { ok: false }.

import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy, extractText, getMeta } from "unpdf";

try {
  const pdf = await getDocumentProxy(new Uint8Array(workerData.bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  let title = null;
  try {
    const meta = await getMeta(pdf);
    title = typeof meta?.info?.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim().slice(0, 200) : null;
  } catch {
    // no metadata is fine
  }
  parentPort.postMessage({ ok: true, text: String(text ?? ""), title, pages: totalPages });
} catch {
  parentPort.postMessage({ ok: false });
}
