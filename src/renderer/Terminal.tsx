import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getBuiPreload } from "./preloadAccess";

type Props = {
  projectName: string;
  active: boolean;
};

const THEME = {
  background: "#0e0f12",
  foreground: "#e6e7ea",
  cursor: "#e6e7ea",
  cursorAccent: "#0e0f12",
  selectionBackground: "#3a4a8a",
  black: "#15171c",
  red: "#ff6b6b",
  green: "#7bd88f",
  yellow: "#ffd866",
  blue: "#7c9cff",
  magenta: "#ff7eb6",
  cyan: "#76e3ea",
  white: "#e6e7ea",
  brightBlack: "#383c47",
  brightRed: "#ff8585",
  brightGreen: "#9ee9aa",
  brightYellow: "#ffe28a",
  brightBlue: "#9bb4ff",
  brightMagenta: "#ff9ec9",
  brightCyan: "#9aedf2",
  brightWhite: "#ffffff",
};

export function Terminal({ projectName, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // dragenter/leave fire for nested elements too — count depth so we only
  // hide the overlay when the cursor truly leaves the terminal area.
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 100000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // URLs → open in the user's default browser via Electron main.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        getBuiPreload()?.openExternal(uri).catch((e) =>
          console.warn("openExternal failed:", e),
        );
      }),
    );

    // Absolute remote paths → click to scp-pull and open with the default app.
    // Match `/foo/bar...` or `~/foo/bar...`, only word-end terminators (so the
    // trailing `.` in "see /tmp/foo." doesn't get included). Requires at least
    // one path segment beyond the root, so bare `/tmp` or `~` won't match.
    const PATH_RE = /(?<![A-Za-z0-9])((?:~|\/)[A-Za-z0-9._/~-]*[A-Za-z0-9_-])/g;
    term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const t = termRef.current;
        if (!t) return callback(undefined);
        const buf = t.buffer.active;
        const line = buf.getLine(lineNumber - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links: ILink[] = [];
        for (const m of text.matchAll(PATH_RE)) {
          const p = m[1];
          // Need ≥1 slash beyond the leading char so "/tmp" is skipped, "/tmp/x" matches.
          const slashes = (p.match(/\//g) || []).length;
          if ((p.startsWith("/") && slashes < 2) || (p.startsWith("~") && slashes < 1)) continue;
          const start = (m.index ?? 0) + m[0].length - p.length;
          links.push({
            range: {
              start: { x: start + 1, y: lineNumber },
              end: { x: start + p.length, y: lineNumber },
            },
            text: p,
            activate: () => {
              window.api.peekRemoteFile(p).catch((e) => {
                alert(e instanceof Error ? e.message : String(e));
              });
            },
            decorations: { underline: true, pointerCursor: true },
          });
        }
        callback(links.length ? links : undefined);
      },
    });
    term.loadAddon(new Unicode11Addon());

    // OSC 52 handler — when the remote sends `\x1b]52;c;<base64>\x1b\\` (e.g.
    // from tmux's copy-pipe → script chain), decode and write to the Mac
    // clipboard via Electron's main-process clipboard module. We do this
    // ourselves instead of using @xterm/addon-clipboard because that addon
    // calls navigator.clipboard.writeText, which Electron silently blocks
    // for non-user-gesture writes (and OSC 52 arrives async, no gesture).
    term.parser.registerOscHandler(52, (data) => {
      console.log("[osc52]", JSON.stringify(data.slice(0, 120)));
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      if (!payload || payload === "?") return false;
      try {
        const text = atob(payload);
        console.log("[osc52] -> clipboard:", JSON.stringify(text.slice(0, 80)));
        getBuiPreload()?.clipboardWriteText(text);
        return true;
      } catch (e) {
        console.warn("[osc52] decode failed:", e);
        return false;
      }
    });
    term.unicode.activeVersion = "11";

    term.open(containerRef.current);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* webgl unavailable, fall back to canvas */
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    // Diagnostic: expose this Terminal's xterm as a window global so we can
    // inspect modes / buffer state from DevTools while reproducing UI bugs.
    (window as unknown as Record<string, unknown>)[`_term_${projectName}`] = term;
    (window as unknown as Record<string, unknown>)._term = term;

    let disposeEvents: (() => void) | null = null;
    let cancelled = false;

    requestAnimationFrame(() => {
      if (cancelled) return;
      try { fit.fit(); } catch { /* not ready, ResizeObserver will retry */ }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      window.api.ptySpawn({ projectName, cols, rows }).then(() => {
        if (cancelled) return;
        disposeEvents = window.api.onPtyEvent((e) => {
          if (e.projectName !== projectName) return;
          if (e.kind === "data") term.write(e.data);
          else if (e.kind === "exit")
            term.write(
              `\r\n\x1b[2m[disconnected from ${projectName}: ${e.code ?? "?"}]\x1b[0m\r\n`,
            );
        });
      });
    });

    const onData = term.onData((data) => {
      window.api.ptyWrite(projectName, data);
    });

    // Skip fit while the container is hidden (display:none → contentRect is
     // 0×0). Without this guard, switching to another project would shrink
     // xterm to its minimum width, and any PTY output that arrived during the
     // hidden period would get stored in scrollback at that tiny width — the
     // "10% of available width" cramping when you came back.
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 50 || rect.height < 50) return;
      try {
        fit.fit();
        window.api.ptyResize(projectName, term.cols, term.rows);
      } catch {
        /* not ready */
      }
    });
    ro.observe(containerRef.current);

    // No custom wheel or mouse handlers. Mouse mode is left ON through the
    // pipeline (tmux + claude) to match native-terminal claude: wheel scrolls
    // claude's conversation, drag-select goes to claude. Cmd+C copies any
    // xterm.js-level selection (shell scrollback / Shift+drag).

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Shift+Enter → newline. xterm.js routes keys through a hidden textarea,
      // and the browser's default for Shift+Enter in a textarea is to insert a
      // literal newline that xterm then forwards as \n. Without preventDefault
      // claude sees that \n in addition to our \x1b\r, and one of them gets
      // treated as submit. preventDefault kills the textarea side; the manual
      // write below mirrors what iTerm2's /terminal-setup sends.
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        window.api.ptyWrite(projectName, "\x1b\r");
        return false;
      }

      const meta = ev.metaKey || ev.ctrlKey;
      if (!meta) return true;

      if (ev.key === "c") {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }
      if (ev.key === "v") {
        navigator.clipboard.readText().then((t) => {
          if (t) window.api.ptyWrite(projectName, t);
        });
        return false;
      }
      if (ev.key === "f") {
        const q = window.prompt("Find:");
        if (q) search.findNext(q);
        return false;
      }
      // Cmd+K = clear xterm scrollback
      if (ev.key === "k" && !ev.shiftKey) {
        term.clear();
        return false;
      }
      return true;
    });

    return () => {
      cancelled = true;
      onData.dispose();
      ro.disconnect();
      disposeEvents?.();
      term.dispose();
      // Don't kill the PTY here — keep the project's tmux attach alive across
      // remounts so switching back doesn't reconnect. ptySpawn replaces an
      // existing entry, so this is safe.
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [projectName]);

  useEffect(() => {
    if (!active) return;
    // First frame: focus immediately. Cheap.
    const raf = requestAnimationFrame(() => {
      try { termRef.current?.focus(); } catch { /* noop */ }
    });
    // After layout settles: refit + force a reflow cycle.
    //
    // xterm.js's reflow only un-wraps lines when widening *enough* that they
    // fit. A simple "shrink by 1 then restore" doesn't actually coalesce
    // anything because there are no lines >cols-1 to merge. Going wider first
    // forces multi-line wrapped sequences to merge back into single lines;
    // shrinking back to current width then re-wraps them at the right width.
    // tmux also gets two SIGWINCHs and repaints its visible screen.
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (!term) return;
        const { cols, rows } = term;
        const wide = Math.max(cols * 2, cols + 200);
        term.resize(wide, rows);
        window.api.ptyResize(projectName, wide, rows);
        requestAnimationFrame(() => {
          const t2 = termRef.current;
          if (!t2) return;
          t2.resize(cols, rows);
          window.api.ptyResize(projectName, cols, rows);
          t2.focus();
        });
      } catch {
        /* not ready */
      }
    }, 50);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [active, projectName]);

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // Two transports, per file: an OS path (Electron preload webUtils) rides
    // the batch scp bridge; no path (desktop HTTP mode / browser —
    // getPathForFile returns "") falls back to shipping the File's bytes via
    // uploadBuffer, same as ChatPanel's drop/paste byte path.
    const withPaths: string[] = [];
    const byteFiles: File[] = [];
    for (const f of files) {
      const lp = window.api.getPathForFile(f);
      if (lp) withPaths.push(lp);
      else byteFiles.push(f);
    }
    setUploading(true);
    try {
      const remotePaths: string[] = [];
      if (withPaths.length > 0) {
        remotePaths.push(
          ...(await window.api.uploadFiles({ projectName, localPaths: withPaths })),
        );
      }
      for (const f of byteFiles) {
        const buffer = await f.arrayBuffer();
        remotePaths.push(
          await window.api.uploadBuffer({ projectName, filename: f.name, buffer }),
        );
      }
      const uploaded = remotePaths.filter((p) => p);
      if (uploaded.length === 0) return;
      const text = uploaded.map(quoteForPrompt).join(" ") + " ";
      window.api.ptyWrite(projectName, text);
      termRef.current?.focus();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="relative h-full w-full"
      style={{ display: active ? "block" : "none" }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={containerRef}
        className="h-full w-full bg-bg outline-none"
        onMouseDown={() => termRef.current?.focus()}
      />
      {(dragOver || uploading) && (
        <div className="absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-bg/70 text-text text-sm pointer-events-none">
          {uploading ? "Uploading…" : "Drop to share with Claude"}
        </div>
      )}
    </div>
  );
}

// Bare path if it's safe shell-text, otherwise single-quote it. Claude reads
// the prompt as plain text and is tolerant of either form.
function quoteForPrompt(p: string): string {
  if (/^[A-Za-z0-9._/~@-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
