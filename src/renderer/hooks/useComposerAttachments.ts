// ===== useComposerAttachments =====
//
// The composer's attachment UPLOAD LIFECYCLE, split out of
// useComposerController the same way ComposerParts was split out of InputArea:
// the parent hook was crossing the codebase's ~500-line module guideline, and
// the upload machinery (drag-drop, clipboard paste, OS-detector screenshots) is
// a self-contained unit with one job — take raw files, mint "uploading" chips,
// and settle each to "ready"/"error" through a SINGLE patch owner (the
// duplication gate, BET-732). It owns no input/model/plan state; it only reads
// the upload target and drives the shared `attachments` array the parent owns.
//
// TWO transports, decided per file (BET-416/732):
//   - OS path available (Electron webUtils via getPathForFile) → batch scp
//     through uploadFiles (desktop SSH mode).
//   - No OS path (desktop HTTP mode / mobile browser → getPathForFile "") →
//     read the File bytes and POST through uploadBuffer (the byte path paste
//     already uses). Without this fallback a drop in HTTP mode silently dropped
//     every file.
//
// `uploadProjectName === null` (a surface with no tmux project, e.g. the CTO
// conversation today) makes every path early-return, so a chip is never
// stranded "uploading" against a target that cannot receive it.

import { useCallback } from "react";
import type { PendingScreenshot } from "../store";
import { useStore } from "../store";
import { type Attachment, guessMime, mimeToInputMode } from "../chatShared";

export type ComposerAttachments = {
  /** Patch one chip by id — the single owner of uploading → ready/error. */
  patchAttachment: (id: string, patch: Partial<Attachment>) => void;
  /** Drag-drop / mobile-attach: mint chips + upload (path batch + byte batch). */
  addDroppedFiles: (files: FileList | File[]) => Promise<void>;
  /** Remove a chip (the ✕ on an attachment chip). */
  removeAttachment: (id: string) => void;
  /** Clipboard paste of image/* → the same chip + upload path as drag-drop. */
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Pending screenshots the OS detector saw (store-owned, active surface only). */
  pendingScreenshots: PendingScreenshot[];
  /** Accept one/all pending screenshots → chips + byte upload. */
  acceptScreenshots: (shots: PendingScreenshot[]) => void;
  /** Discard a pending screenshot without attaching it. */
  removePendingScreenshots: (ids: string[]) => void;
};

export function useComposerAttachments(params: {
  // The SSH/HTTP upload target. null → no target; every path early-returns.
  uploadProjectName: string | null;
  // The parent-owned attachments array setter (chips live with the parent so
  // the host's send path reads them without a second copy).
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
}): ComposerAttachments {
  const { uploadProjectName, setAttachments } = params;

  // The single owner of the "uploading" → "ready"/"error" transition — every
  // upload path routes its completion through this (duplication gate, BET-732).
  const patchAttachment = useCallback(
    (id: string, patch: Partial<Attachment>) => {
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    },
    [setAttachments],
  );

  const addDroppedFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!uploadProjectName) return;
      const list = Array.from(files);
      if (list.length === 0) return;
      type Pending = { file: File; lp: string; mime: string; asPathRef: boolean; id: string };
      const pending: Pending[] = list.map((f) => {
        const mime = f.type || guessMime(f.name);
        return {
          file: f,
          lp: window.api.getPathForFile(f),
          mime,
          asPathRef: mimeToInputMode(mime) === "other",
          id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        };
      });
      const newChips: Attachment[] = pending.map((p) => ({
        id: p.id,
        filename: p.file.name,
        mime: p.mime,
        status: "uploading",
        source: "drop",
        asPathRef: p.asPathRef,
      }));
      setAttachments((prev) => [...prev, ...newChips]);
      const settleReady = (id: string, rp: string | null) =>
        patchAttachment(
          id,
          rp
            ? { status: "ready", remotePath: rp }
            : { status: "error", errorMsg: "Upload returned no path" },
        );
      const pathPending = pending.filter((p) => p.lp);
      const pathBatch = (async () => {
        if (pathPending.length === 0) return;
        let remotePaths: string[] = [];
        try {
          remotePaths = await window.api.uploadFiles({
            projectName: uploadProjectName,
            localPaths: pathPending.map((p) => p.lp),
          });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          for (const p of pathPending) patchAttachment(p.id, { status: "error", errorMsg: msg });
          return;
        }
        pathPending.forEach((p, i) => settleReady(p.id, remotePaths[i] ?? null));
      })();
      const bytePending = pending.filter((p) => !p.lp);
      const byteBatch = Promise.all(
        bytePending.map(async (p) => {
          try {
            const buffer = await p.file.arrayBuffer();
            const rp = await window.api.uploadBuffer({
              projectName: uploadProjectName,
              filename: p.file.name,
              buffer,
            });
            settleReady(p.id, rp || null);
          } catch (e) {
            patchAttachment(p.id, { status: "error", errorMsg: String((e as Error)?.message ?? e) });
          }
        }),
      );
      await Promise.all([pathBatch, byteBatch]);
    },
    [uploadProjectName, patchAttachment, setAttachments],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [setAttachments],
  );

  // Clipboard paste of image/* → same chip + upload path as drag-drop.
  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!uploadProjectName) return;
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const mime = item.type;
        const ext = mime.split("/")[1] ?? "png";
        const filename = `screenshot-${Date.now()}.${ext}`;
        const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setAttachments((prev) => [
          ...prev,
          { id, filename, mime, status: "uploading", source: "paste" } as Attachment,
        ]);
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const remotePath = await window.api.uploadBuffer({
            projectName: uploadProjectName,
            filename,
            buffer: arrayBuffer,
          });
          patchAttachment(id, { status: "ready", remotePath });
        } catch (err) {
          patchAttachment(id, { status: "error", errorMsg: String((err as Error)?.message ?? err) });
        }
      }
    },
    [uploadProjectName, patchAttachment, setAttachments],
  );

  // Pending screenshots the OS detector saw — only the active surface acts on
  // them (acting clears the global records).
  const pendingScreenshots = useStore((s) => s.pendingScreenshots);
  const removePendingScreenshots = useStore((s) => s.removePendingScreenshots);
  const acceptScreenshots = useCallback(
    (shots: PendingScreenshot[]) => {
      removePendingScreenshots(shots.map((s) => s.id));
      if (!uploadProjectName) return;
      for (const shot of shots) {
        const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setAttachments((prev) => [
          ...prev,
          { id, filename: shot.filename, mime: "image/png", status: "uploading", source: "paste" } as Attachment,
        ]);
        void (async () => {
          try {
            const remotePath = await window.api.uploadBuffer({
              projectName: uploadProjectName,
              filename: shot.filename,
              buffer: shot.bytes,
            });
            if (!remotePath) throw new Error("Upload failed");
            patchAttachment(id, { status: "ready", remotePath });
          } catch (err) {
            patchAttachment(id, { status: "error", errorMsg: String((err as Error)?.message ?? err) });
          }
        })();
      }
    },
    [uploadProjectName, removePendingScreenshots, patchAttachment, setAttachments],
  );

  return {
    patchAttachment,
    addDroppedFiles,
    removeAttachment,
    onPaste,
    pendingScreenshots,
    acceptScreenshots,
    removePendingScreenshots,
  };
}
