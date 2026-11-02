// CodeViewer.tsx — the Explorer's read-only code view: CodeMirror 6 through
// @uiw/react-codemirror with basicSetup off (contract E6,
// docs/screens/explorer/contract.md). Line numbers, find (⌘F), go to line (⌘L),
// target-line highlight scrolled to ~⅓ from the top, language by filename from
// @codemirror/language-data (lazy chunks), syntax colours from the transcript's
// Prism themes via prismHighlight.ts.
//
// Everything that changes after the editor exists — theme, language, the target
// lines, and a refreshed file's text — is dispatched into the live view (theme /
// language / target through Compartments), never by rebuilding it, so a refresh
// keeps the scroll position. The `extensions` prop is deliberately stable:
// @uiw/react-codemirror reconfigures the whole editor when it changes.

import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Compartment, RangeSet, type Extension, type StateEffect, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutterLineClass,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { gotoLine, search, searchKeymap } from "@codemirror/search";
import { themes } from "prism-react-renderer";
import { useResolvedTheme, type ResolvedTheme } from "../theme";
import { prismThemeToHighlightStyle } from "./prismHighlight";

/** The language-data description for a filename (name shown in the footer), or null. */
export function languageDescriptionFor(filename: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, filename);
}

// Values are CSS variables only (contract E6) — no raw colours.
const CHROME = {
  "&": { height: "100%", backgroundColor: "var(--canvas)", color: "var(--tx1)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { padding: "var(--sp-2) 0" },
  ".cm-line": { padding: "0 var(--sp-4) 0 0" },
  ".cm-gutters": { backgroundColor: "var(--canvas)", color: "var(--tx4)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "48px", padding: "0 var(--sp-4) 0 0" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgb(var(--accent-rgb) / .25)",
  },
  ".cm-manta-target": { backgroundColor: "var(--accent-bg)", boxShadow: "inset 2px 0 0 var(--accent)" },
  ".cm-manta-target-gutter": { color: "var(--accent-tx)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-bg)" },
  ".cm-searchMatch-selected": { backgroundColor: "rgb(var(--warn-rgb) / .35)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--tx1)", borderColor: "var(--border-subtle)" },
  ".cm-panel input": {
    background: "var(--canvas)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-xs)",
    padding: "var(--sp-1) var(--sp-2)",
    fontSize: "var(--font-size-xs)",
    color: "var(--tx1)",
  },
  ".cm-panel button": {
    background: "transparent",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--r-sm)",
    padding: "var(--sp-1) var(--sp-2)",
    fontSize: "var(--font-size-xs)",
    color: "var(--tx2)",
  },
};

const themeCache = new Map<ResolvedTheme, Extension>();

/** Chrome theme + Prism-derived syntax colours for one app theme. */
export function explorerTheme(resolved: ResolvedTheme): Extension {
  let ext = themeCache.get(resolved);
  if (!ext) {
    const prism = resolved === "light" ? themes.github : themes.vsDark;
    ext = [
      EditorView.theme(CHROME, { dark: resolved !== "light" }),
      syntaxHighlighting(prismThemeToHighlightStyle(prism)),
    ];
    themeCache.set(resolved, ext);
  }
  return ext;
}

const TARGET_LINE = Decoration.line({ class: "cm-manta-target" });

class TargetGutterMarker extends GutterMarker {
  elementClass = "cm-manta-target-gutter";
}
const TARGET_MARKER = new TargetGutterMarker();

/** Highlight (and gutter-mark) lines `start..end` (1-based, already clamped). */
export function targetExtension(doc: Text, start: number, end: number): Extension {
  const lines = [];
  const marks = [];
  for (let n = start; n <= end; n++) {
    const from = doc.line(n).from;
    lines.push(TARGET_LINE.range(from));
    marks.push(TARGET_MARKER.range(from));
  }
  return [EditorView.decorations.of(Decoration.set(lines)), gutterLineClass.of(RangeSet.of(marks))];
}

/** The smallest single change turning `from` into `to`. */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  const max = Math.min(from.length, to.length);
  let p = 0;
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && from.charCodeAt(from.length - 1 - s) === to.charCodeAt(to.length - 1 - s)) s++;
  return { from: p, to: from.length - s, insert: to.slice(p, to.length - s) };
}

export function CodeViewer({
  text,
  filename,
  line,
  endLine,
}: {
  text: string;
  filename: string;
  /** 1-based target range; the first line is scrolled to ~⅓ from the top. */
  line?: number;
  endLine?: number;
}) {
  const resolved = useResolvedTheme();
  const [view, setView] = useState<EditorView | null>(null);
  // The editor is created once from this; later text arrives as a minimal change.
  const initialText = useRef(text);
  const compartments = useMemo(
    () => ({ theme: new Compartment(), language: new Compartment(), target: new Compartment() }),
    [],
  );

  const extensions = useMemo<Extension[]>(
    () => [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      search({ top: true }),
      keymap.of([...searchKeymap, { key: "Mod-l", run: gotoLine, preventDefault: true }]),
      // A non-editable content element is not focusable by itself; ⌘F / ⌘L need focus.
      EditorView.contentAttributes.of({ tabindex: "0" }),
      compartments.theme.of(explorerTheme(resolved)),
      compartments.language.of([]),
      compartments.target.of([]),
    ],
    // `resolved` is the initial theme only; flips go through the compartment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compartments],
  );

  useEffect(() => {
    view?.dispatch({ effects: compartments.theme.reconfigure(explorerTheme(resolved)) });
  }, [view, resolved, compartments]);

  useEffect(() => {
    if (!view) return;
    const desc = languageDescriptionFor(filename);
    if (!desc) return;
    let cancelled = false;
    desc
      .load()
      .then((support) => {
        if (!cancelled) view.dispatch({ effects: compartments.language.reconfigure(support) });
      })
      .catch((e) => console.warn("[explorer] language load failed:", filename, e));
    return () => {
      cancelled = true;
    };
  }, [view, filename, compartments]);

  // A refreshed file: apply only what changed so the scroll position holds.
  useEffect(() => {
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === text) return;
    view.dispatch({ changes: minimalChange(cur, text) });
  }, [view, text]);

  // Highlight the target lines; scroll only when the target itself changed.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!view) return;
    const doc = view.state.doc;
    if (!line || line < 1) {
      view.dispatch({ effects: compartments.target.reconfigure([]) });
      scrolledFor.current = null;
      return;
    }
    const start = Math.min(line, doc.lines);
    const end = Math.max(start, Math.min(endLine ?? start, doc.lines));
    const effects: StateEffect<unknown>[] = [compartments.target.reconfigure(targetExtension(doc, start, end))];
    const key = `${start}-${end}`;
    if (scrolledFor.current !== key) {
      scrolledFor.current = key;
      effects.push(
        EditorView.scrollIntoView(doc.line(start).from, {
          y: "start",
          yMargin: Math.round(view.scrollDOM.clientHeight / 3),
        }),
      );
    }
    view.dispatch({ effects });
  }, [view, text, line, endLine, compartments]);

  return (
    <div className="manta-explorer-code h-full">
      <CodeMirror
        value={initialText.current}
        height="100%"
        theme="none"
        basicSetup={false}
        editable={false}
        readOnly
        indentWithTab={false}
        extensions={extensions}
        onCreateEditor={(v) => setView(v)}
      />
    </div>
  );
}
