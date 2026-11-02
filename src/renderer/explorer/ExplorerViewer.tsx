// ExplorerViewer.tsx — the Explorer's file view: file bar (E5), body (code E6,
// Markdown E7, media, refusals E12, empty/loading/error E12b) and footer (E8).
// Spec: docs/superpowers/specs/2026-11-02-file-explorer.md §Explorer panel;
// chrome: docs/screens/explorer/contract.md.
//
// One FileView per opened file (keyed by path): loading, the size/binary guards
// and refusals live in filePeek.ts; this file maps their outcomes to states. A
// refresh (the shell bumps `refreshKey`) re-reads the open file WITHOUT going
// back to the loading state, and flashes "Updated" when the content changed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Binary,
  Check,
  Copy,
  Download,
  FileWarning,
  FileX,
  FolderTree,
  Link as LinkIcon,
  Lock,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "../Button";
import { Callout } from "../Callout";
import { IconButton } from "../IconButton";
import { MarkdownBody } from "../MarkdownBody";
import { Dropdown, MenuItem } from "../MenuItem";
import { Pill } from "../Pill";
import { Segmented } from "../Segmented";
import { Skeleton } from "../Skeleton";
import { useStore } from "../store";
import { relativeAge } from "../secretsView";
import { countPreviewLines, formatBytes, MAX_PREVIEW_BYTES, previewLanguage } from "../chatUtils";
import { saveToDownloads } from "../downloadFeedback";
import { CodeViewer, languageDescriptionFor } from "./CodeViewer";
import { MediaBody, usePeekedMedia, type MediaDims } from "./MediaBody";
import { createImageResolver, loadPeekedFile, type MediaKind, type PeekFailure, type PeekOutcome } from "./filePeek";
import { COPY_CONFIRM_MS, LOADING_DELAY_MS, UPDATED_PILL_MS, basename, dirname, isInsideRoot } from "./layout";
import {
  PREVIEW_PATH_EVENT,
  type ExplorerViewerProps,
  type FileTarget,
  type MarkdownFileContext,
  type MdView,
} from "./types";

/** Markdown above this many characters opens in Source. */
export const LARGE_MARKDOWN_CHARS = 50_000;

const COPY_FAILED = "Couldn’t copy — the clipboard is unavailable";

const MARKDOWN_RE = /\.(md|markdown)$/i;
export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_RE.test(name);
}

/** `to` relative to the folder `from` (`../x` when it lies outside). */
export function relativeTo(from: string, to: string): string {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  return [...up, ...b.slice(i)].join("/") || ".";
}

/** `#L12` / `#L12-L20` in a link fragment → a line range. */
export function lineFromFragment(frag: string): { line: number; endLine?: number } | null {
  const m = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag);
  if (!m) return null;
  const line = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return line > 0 ? { line, endLine: end && end >= line ? end : undefined } : null;
}

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

function toast(message: string, error = false) {
  useStore.getState().pushAppToast(error ? { tone: "error", message } : { message });
}

/** A short reason a file cannot be copied, or null when it can. */
export function copyDisabledReason(outcome: PeekOutcome | null): string | null {
  if (!outcome) return "Loading…";
  switch (outcome.status) {
    case "text":
      return null;
    case "empty":
      return "This file is empty";
    case "too-large":
      return "Too large to copy";
    case "binary":
      return "Binary files can’t be copied";
    case "media":
      return "Only text files can be copied";
    default:
      return "Couldn’t load this file";
  }
}

// ---------------------------------------------------------------------------
// States (E12 / E12b)
// ---------------------------------------------------------------------------

function StateColumn({
  hook,
  icon,
  title,
  detail,
  children,
}: {
  hook: "manta-explorer-state" | "manta-explorer-refusal";
  icon: JSX.Element;
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`${hook} flex h-full flex-col items-center justify-center gap-1 px-4 py-8 text-center`}>
      {icon}
      <span className="text-label font-medium text-text">{title}</span>
      {detail && <span className="text-meta text-text-faint">{detail}</span>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

const glyph = "mb-1 text-text-faint";

function DownloadButton({ abs }: { abs: string }) {
  return (
    <Button tone="primary" onClick={() => void saveToDownloads(abs)}>
      <Download size={14} aria-hidden />
      Download
    </Button>
  );
}

function TooLarge({ abs, name, size }: { abs: string; name: string; size?: number }) {
  const limit = formatBytes(MAX_PREVIEW_BYTES);
  return (
    <StateColumn
      hook="manta-explorer-refusal"
      icon={<FileWarning size={20} className={glyph} aria-hidden />}
      title="Too large to preview"
      detail={size ? `${name} is ${formatBytes(size)} · the limit is ${limit}` : `${name} is over the ${limit} limit`}
    >
      <DownloadButton abs={abs} />
    </StateColumn>
  );
}

function FailureView({
  reason,
  abs,
  name,
  onRetry,
}: {
  reason: PeekFailure | "too-large";
  abs: string;
  name: string;
  onRetry: () => void;
}) {
  if (reason === "too-large") return <TooLarge abs={abs} name={name} />;
  if (reason === "missing" || reason === "not-file") {
    return (
      <StateColumn
        hook="manta-explorer-refusal"
        icon={<FileX size={20} className={glyph} aria-hidden />}
        title="No longer exists"
        detail="Moved or deleted after it was mentioned"
      />
    );
  }
  if (reason === "permission" || reason === "outside-home") {
    return (
      <StateColumn
        hook="manta-explorer-refusal"
        icon={<Lock size={20} className={glyph} aria-hidden />}
        title="Can’t read this file"
        detail={
          reason === "outside-home"
            ? "It is outside your home folder"
            : "The box user has no permission to open it"
        }
      />
    );
  }
  const detail =
    reason === "network"
      ? "The box didn’t answer. Check the connection."
      : reason === "changed"
        ? "The file changed while it was being read."
        : "The box couldn’t read this file.";
  return (
    <StateColumn
      hook="manta-explorer-state"
      icon={<FileWarning size={20} className={glyph} aria-hidden />}
      title="Couldn’t load this file"
      detail={detail}
    >
      <Button tone="default" onClick={onRetry}>
        Retry
      </Button>
    </StateColumn>
  );
}

/** Nothing for LOADING_DELAY_MS, then three uneven bars. */
function LoadingBody() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="manta-explorer-state flex flex-col gap-3 px-6 py-5" role="status" aria-label="Loading">
      <Skeleton width={60} />
      <Skeleton width={85} />
      <Skeleton width={40} />
    </div>
  );
}

function ExplorerEmpty({ onShowTree }: { onShowTree: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="min-h-0 flex-1">
        <StateColumn
          hook="manta-explorer-state"
          icon={<FolderTree size={20} className={glyph} aria-hidden />}
          title="No file open"
          detail="Click a file path in the conversation, or open the tree"
        >
          <Button tone="default" onClick={onShowTree}>
            Show tree
          </Button>
        </StateColumn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function MediaView({
  abs,
  name,
  kind,
  version,
  onDims,
  onRetry,
}: {
  abs: string;
  name: string;
  kind: "image" | "video";
  version: number;
  onDims: (d: MediaDims) => void;
  onRetry: () => void;
}) {
  const media = usePeekedMedia(abs, version);
  if (media.status === "loading") return <LoadingBody />;
  if (media.status === "failed") return <FailureView reason={media.reason} abs={abs} name={name} onRetry={onRetry} />;
  return (
    <div className="h-full">
      <MediaBody kind={kind} url={media.url} label={name} onDims={onDims} />
    </div>
  );
}

function mediaLabel(kind: MediaKind): string {
  return kind === "image" ? "Image" : kind === "video" ? "Video" : "PDF";
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

export function ExplorerViewer(props: ExplorerViewerProps) {
  if (!props.file) return <ExplorerEmpty onShowTree={props.onShowTree} />;
  return <FileView key={props.file.abs} {...props} file={props.file} />;
}

function sameContent(a: PeekOutcome | null, b: PeekOutcome): boolean {
  if (!a || a.status !== b.status) return false;
  if (a.status === "text" && b.status === "text") return a.text === b.text;
  if ((a.status === "media" && b.status === "media") || (a.status === "too-large" && b.status === "too-large")) {
    return a.size === b.size;
  }
  if (a.status === "binary" && b.status === "binary") return a.size === b.size;
  if (a.status === "failed" && b.status === "failed") return a.reason === b.reason;
  return true;
}

type Stat = { mtimeMs: number } | null;

async function fetchStat(abs: string): Promise<Stat> {
  try {
    const { results } = await window.api.fsResolvePaths({ base: dirname(abs), paths: [abs] });
    const r = results[0];
    return r && r.ok ? { mtimeMs: r.mtimeMs } : null;
  } catch {
    // Metadata for the footer only — the file itself loads (or fails) on its own.
    return null;
  }
}

function FileView({
  owner,
  root,
  file,
  mdView,
  onMdViewChange,
  onOpen,
  refreshKey,
}: ExplorerViewerProps & { file: FileTarget }) {
  const { abs, line, endLine } = file;
  const name = basename(abs);
  const fileDir = dirname(abs);

  const [outcome, setOutcome] = useState<PeekOutcome | null>(null);
  const [mtimeMs, setMtimeMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mediaVersion, setMediaVersion] = useState(0);
  const [dims, setDims] = useState<MediaDims | null>(null);
  const [updated, setUpdated] = useState(false);
  const [updatedTick, setUpdatedTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuFocus = useRef(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<PeekOutcome | null>(null);

  // Load, and re-load on refresh / retry. A refresh is silent: the content on
  // screen stays until the new content is in hand.
  useEffect(() => {
    const ctrl = new AbortController();
    const prev = outcomeRef.current;
    const silent = prev != null && prev.status !== "failed";
    if (!silent) {
      outcomeRef.current = null;
      setOutcome(null);
    }
    void (async () => {
      const [out, stat] = await Promise.all([loadPeekedFile(abs, ctrl.signal), fetchStat(abs)]);
      if (ctrl.signal.aborted) return;
      // A background refresh that could not reach the box keeps what is shown.
      if (silent && out.status === "failed" && (out.reason === "network" || out.reason === "unavailable" || out.reason === "changed")) {
        return;
      }
      const changed = silent && !sameContent(prev, out);
      outcomeRef.current = out;
      setOutcome(out);
      setMtimeMs(stat?.mtimeMs ?? null);
      if (changed) {
        setUpdatedTick((t) => t + 1);
        if (out.status === "media") setMediaVersion((v) => v + 1);
      }
    })().catch((e) => {
      if (!ctrl.signal.aborted) console.warn("[explorer] load failed:", abs, e);
    });
    return () => ctrl.abort();
  }, [abs, refreshKey, attempt]);

  useEffect(() => {
    if (!updatedTick) return;
    setUpdated(true);
    const t = setTimeout(() => setUpdated(false), UPDATED_PILL_MS);
    return () => clearTimeout(t);
  }, [updatedTick]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [copied]);

  // --- Markdown view ---
  const isMd = isMarkdownFile(name);
  const text = outcome?.status === "text" ? outcome.text : null;
  const large = isMd && text != null && text.length > LARGE_MARKDOWN_CHARS;
  // A link with a line target opens Source there without touching the preference.
  const [forcedSource, setForcedSource] = useState(line != null);
  useEffect(() => setForcedSource(line != null), [abs, line, endLine]);
  const effectiveView: MdView = large || forcedSource ? "source" : mdView;
  const showSegmented = isMd && text != null && !large;
  const showsCode = text != null && !(isMd && effectiveView === "rendered");

  const chooseView = useCallback(
    (v: MdView) => {
      setForcedSource(false);
      onMdViewChange(v);
    },
    [onMdViewChange],
  );

  // ⇧⌘V (Ctrl+Shift+V off macOS) toggles Rendered ↔ Source.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!showSegmented) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      chooseView(effectiveView === "rendered" ? "source" : "rendered");
    }
  };

  // --- Markdown links & images ---
  const latest = useRef({ owner, onOpen });
  latest.current = { owner, onOpen };
  const resolver = useMemo(() => createImageResolver(fileDir, (i) => window.api.fsResolvePaths(i)), [fileDir]);
  useEffect(() => () => resolver.dispose(), [resolver]);

  const openLink = useCallback(
    (href: string) => {
      if (href.startsWith("#")) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          /* keep the raw fragment */
        }
        const target = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((el) => el.id === id);
        if (target) target.scrollIntoView?.({ block: "start" });
        else toast(`No section “${id}” in this file`, true);
        return;
      }
      const hash = href.indexOf("#");
      const frag = hash >= 0 ? href.slice(hash + 1) : "";
      let path = hash >= 0 ? href.slice(0, hash) : href;
      const q = path.indexOf("?");
      if (q >= 0) path = path.slice(0, q);
      try {
        path = decodeURI(path);
      } catch {
        /* keep the raw path */
      }
      void (async () => {
        try {
          const { results } = await window.api.fsResolvePaths({ base: fileDir, paths: [path] });
          const r = results[0];
          if (r && r.ok) {
            latest.current.onOpen({
              abs: r.abs,
              kind: r.kind,
              owner: latest.current.owner,
              ...(r.kind === "file" ? (lineFromFragment(frag) ?? {}) : {}),
            });
            return;
          }
          const why = r && !r.ok && (r.reason === "missing" || r.reason === "not-file") ? "it doesn’t exist" : "it can’t be opened";
          toast(`Couldn’t open ${path} — ${why}`, true);
        } catch {
          toast(`Couldn’t open ${path} — the box didn’t answer`, true);
        }
      })();
    },
    [fileDir],
  );
  const fileContext = useMemo<MarkdownFileContext>(
    () => ({ openLink, resolveImage: resolver.resolveImage }),
    [openLink, resolver],
  );

  // The More menu follows the same keyboard pattern as the session menu: focus
  // moves onto the surface, arrows rove across the rows, Enter activates one.
  const menuRows = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
  const focusMenuRow = (idx: number) => {
    const rows = menuRows();
    if (rows.length === 0) return;
    const i = (idx + rows.length) % rows.length;
    rows.forEach((r, n) => (r.tabIndex = n === i ? 0 : -1));
    rows[i].focus();
    menuFocus.current = i;
  };
  useEffect(() => {
    if (!menuOpen) return;
    menuFocus.current = -1;
    menuRows().forEach((r) => (r.tabIndex = -1));
    if (menuRef.current) {
      menuRef.current.tabIndex = -1;
      menuRef.current.focus();
    }
  }, [menuOpen]);
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusMenuRow(menuFocus.current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusMenuRow(menuFocus.current < 0 ? menuRows().length - 1 : menuFocus.current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusMenuRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusMenuRow(menuRows().length - 1);
    }
  };

  // --- Copy / menu ---
  const copyReason = copyDisabledReason(outcome);
  const copyContents = async () => {
    if (text == null) return;
    try {
      await writeClipboard(text);
      setCopied(true);
    } catch {
      toast(COPY_FAILED, true);
    }
  };
  const copyPath = async (value: string) => {
    setMenuOpen(false);
    try {
      await writeClipboard(value);
      toast("Path copied");
    } catch {
      toast(COPY_FAILED, true);
    }
  };

  const retry = () => setAttempt((a) => a + 1);
  const downloadable = outcome != null && outcome.status !== "failed";

  // --- File bar pieces ---
  const rel = isInsideRoot(root, abs) && abs !== root ? abs.slice(root.replace(/\/+$/, "").length + 1) : abs;
  const dirs = rel.split("/").filter(Boolean).slice(0, -1);
  const targetText =
    showsCode && line != null ? (endLine != null && endLine > line ? `· lines ${line}–${endLine}` : `· line ${line}`) : null;

  const lines = text != null ? countPreviewLines(text) : 0;
  const language = languageDescriptionFor(name)?.name ?? (previewLanguage(name) === "text" ? "Plain text" : previewLanguage(name));

  let body: React.ReactNode;
  if (outcome == null) {
    body = <LoadingBody />;
  } else if (outcome.status === "empty") {
    body = <div className="manta-explorer-state px-6 py-5 text-meta text-text-faint">Empty file</div>;
  } else if (outcome.status === "too-large") {
    body = <TooLarge abs={abs} name={name} size={outcome.size} />;
  } else if (outcome.status === "binary") {
    body = (
      <StateColumn
        hook="manta-explorer-refusal"
        icon={<Binary size={20} className={glyph} aria-hidden />}
        title="Binary file"
        detail={`${name} can’t be shown as text`}
      >
        <DownloadButton abs={abs} />
      </StateColumn>
    );
  } else if (outcome.status === "failed") {
    body = <FailureView reason={outcome.reason} abs={abs} name={name} onRetry={retry} />;
  } else if (outcome.status === "media") {
    body =
      outcome.kind === "pdf" ? (
        <div className="manta-explorer-state flex h-full items-center justify-center">
          <Button
            tone="default"
            onClick={() => window.dispatchEvent(new CustomEvent(PREVIEW_PATH_EVENT, { detail: { path: abs } }))}
          >
            Open preview
          </Button>
        </div>
      ) : (
        <MediaView
          abs={abs}
          name={name}
          kind={outcome.kind}
          version={mediaVersion + attempt}
          onDims={setDims}
          onRetry={retry}
        />
      );
  } else if (isMd && effectiveView === "rendered") {
    body = (
      <div className="manta-explorer-md flex max-w-[var(--measure)] flex-col gap-[var(--block-gap)] break-words px-6 py-5 text-prose text-text">
        <MarkdownBody text={outcome.text} fileContext={fileContext} />
      </div>
    );
  } else {
    body = (
      <div className="flex h-full flex-col">
        {large && (
          <div className="shrink-0 px-3">
            <Callout tone="info" size="note">
              Large file — showing source
            </Callout>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <CodeViewer text={outcome.text} filename={name} line={line} endLine={endLine} />
        </div>
      </div>
    );
  }

  let footer: React.ReactNode = null;
  if (outcome?.status === "text" || outcome?.status === "media") {
    const modified = mtimeMs != null ? relativeAge(mtimeMs, Date.now()) : "";
    footer = (
      <div className="manta-explorer-footer flex h-7 shrink-0 items-center gap-3 border-t border-border-subtle bg-bg-elev px-3 text-meta text-text-faint">
        {outcome.status === "text" ? (
          <>
            <span>{language}</span>
            <span>{lines} lines</span>
          </>
        ) : (
          <>
            <span>{mediaLabel(outcome.kind)}</span>
            {outcome.kind === "image" && dims && (
              <span>
                {dims.width} × {dims.height}
              </span>
            )}
          </>
        )}
        <span>{formatBytes(outcome.size)}</span>
        {showsCode && line != null ? (
          <span className="ml-auto">Ln {line}</span>
        ) : modified ? (
          <span className="ml-auto">modified {modified}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg" onKeyDown={onKeyDown}>
      <div className="manta-explorer-filebar flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-elev pl-3 pr-2">
        <span
          className="min-w-0 flex-1 truncate text-left font-mono text-meta text-text-faint [direction:rtl]"
          title={abs}
        >
          <bdi>
            {dirs.map((d) => `${d} / `).join("")}
            <span className="font-medium text-text">{name}</span>
            {targetText && <span className="text-text-faint"> {targetText}</span>}
          </bdi>
        </span>
        {showSegmented && (
          <Segmented<MdView>
            label="Markdown view"
            options={[
              { id: "rendered", label: "Rendered" },
              { id: "source", label: "Source" },
            ]}
            value={effectiveView}
            onChange={chooseView}
          />
        )}
        {updated && (
          <Pill tone="neutral" size="meta">
            Updated
          </Pill>
        )}
        <IconButton
          icon={copied ? <Check className="text-ok" /> : <Copy />}
          label={copied ? "Copied" : "Copy contents"}
          title={copyReason ?? (copied ? "Copied" : "Copy contents")}
          disabled={copyReason != null}
          onClick={() => void copyContents()}
        />
        <IconButton
          icon={<Download />}
          label="Download"
          title={downloadable ? `Download ${name}` : "Nothing to download"}
          disabled={!downloadable}
          onClick={() => void saveToDownloads(abs)}
        />
        <IconButton
          icon={<MoreHorizontal />}
          label="More"
          ariaHaspopup="menu"
          ariaExpanded={menuOpen}
          buttonRef={moreRef}
          onClick={() => setMenuOpen((o) => !o)}
        />
        <Dropdown
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={moreRef}
          panelRef={menuRef}
          onKeyDown={onMenuKeyDown}
          align="end"
          width="menu"
        >
          <MenuItem icon={<LinkIcon />} onSelect={() => void copyPath(abs)}>
            Copy path
          </MenuItem>
          <MenuItem icon={<LinkIcon />} onSelect={() => void copyPath(relativeTo(owner.cwd, abs))}>
            Copy relative path
          </MenuItem>
        </Dropdown>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
      {footer}
    </div>
  );
}
