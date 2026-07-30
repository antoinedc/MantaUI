import { useEffect, useState } from "react";

// BET-409 — light theme. Theme resolution + live application.
//
// The persisted preference (AppConfig.theme) is "system" | "light" | "dark".
// "system" follows `prefers-color-scheme: dark` and re-themes live when the OS
// flips. The resolved value is written as `data-theme` on <html> (the attribute
// the [data-theme="dark"] / [data-theme="light"] blocks in index.css key on)
// and mirrored to <meta name="theme-color"> so the browser chrome / PWA status
// bar matches.
//
// `applyTheme` is the single entry point: it manages ONE matchMedia subscriber
// (system mode) and notifies registered listeners (useResolvedTheme) so Prism
// code blocks and the Terminal pane re-tint without a reload. Idempotent —
// calling it repeatedly is safe; each call tears down the prior subscription.
//
// Environment-safe: the module is imported (transitively, via store/MarkdownBody)
// by unit tests that run in pure Node (no `document`) and jsdom (no
// `window.matchMedia`). All DOM/matchMedia access is guarded so importing the
// module never throws; in a DOM-less context applyTheme is a safe no-op and
// the resolved theme defaults to "dark".

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

// Meta theme-color per resolved theme — the canvas colour so the OS chrome /
// PWA status bar blends with the app surface. Must stay in sync with --canvas
// in index.css (sub-issue 04 will derive these from the token instead).
const THEME_META: Record<ResolvedTheme, string> = {
  light: "#FAF9F7",
  dark: "#0B1020",
};

const DARK_MQ = "(prefers-color-scheme: dark)";

const hasDOM = typeof document !== "undefined" && typeof window !== "undefined";

/** matchMedia result for prefers-color-scheme: dark, or null if unavailable. */
function prefersDark(): boolean | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(DARK_MQ).matches;
}

const listeners = new Set<(t: ResolvedTheme) => void>();
// Lazily computed — never touched at module load so importing this module in a
// DOM-less test environment is side-effect free.
let current: ResolvedTheme | null = null;

function readInitial(): ResolvedTheme {
  if (!hasDOM) return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  // matchMedia unavailable (jsdom) → fall back to dark (the HTML default).
  return prefersDark() === false ? "light" : "dark";
}

function getCurrent(): ResolvedTheme {
  if (current === null) current = readInitial();
  return current;
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return prefersDark() === false ? "light" : "dark";
  return pref;
}

function commit(resolved: ResolvedTheme): void {
  if (resolved === getCurrent()) return;
  current = resolved;
  if (hasDOM) {
    document.documentElement.setAttribute("data-theme", resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_META[resolved]);
  }
  for (const l of listeners) l(resolved);
}

/** Apply a theme preference, subscribing to OS changes when "system". */
export function applyTheme(pref?: ThemePref): void {
  const theme: ThemePref = pref ?? "system";
  // Tear down any prior system-mode subscription before re-subscribing so
  // switching system → explicit stops following the OS, and explicit → system
  // starts. A single global subscriber is kept (never leaked across calls).
  if (mediaMq && mediaHandler) {
    mediaMq.removeEventListener("change", mediaHandler);
    mediaHandler = null;
    mediaMq = null;
  }
  if (theme === "system" && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    mediaMq = window.matchMedia(DARK_MQ);
    mediaHandler = () => commit(resolve("system"));
    mediaMq.addEventListener("change", mediaHandler);
  }
  commit(resolve(theme));
}

let mediaMq: MediaQueryList | null = null;
let mediaHandler: (() => void) | null = null;

/** Read the currently resolved theme without subscribing. */
export function getResolvedTheme(): ResolvedTheme {
  return getCurrent();
}

/**
 * React hook: the resolved theme, re-rendering the caller when it changes
 * (OS flip in system mode, or an applyTheme call from Settings). Safe inside a
 * React.memo'd component — the internal state update forces a re-render even
 * when the parent's props are unchanged, so hot memoized code blocks / panes
 * re-tint live.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [t, setT] = useState<ResolvedTheme>(getCurrent);
  useEffect(() => {
    // Sync in case current changed between render and effect commit.
    setT(getCurrent());
    const l = (next: ResolvedTheme) => setT(next);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return t;
}
