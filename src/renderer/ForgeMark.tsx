// ForgeMark — the forge brand mark (GitHub today; GitLab when an adapter exists).
//
// lucide-react ships NO brand glyphs — they were removed upstream — so the two
// paths live here rather than as a new dependency: `simple-icons` /
// `react-icons` would add a multi-megabyte icon set for two marks.
//
// Decorative BY CONTRACT: monochrome `currentColor`, `aria-hidden`, and never
// the only label — every call site pairs it with real text (or, for the
// icon-only open-on-forge button, a `title`). That is what GitHub's brand
// guidelines ask for when the mark indicates GitHub, and it is why there is no
// `label`/`title` prop here.
//
// An unknown or absent kind renders NOTHING (not a wrong logo, not a fallback
// glyph): a session on a forge we have no adapter for must not claim GitHub.
// Call sites that draw a separator beside the mark gate it on `hasForgeMark`.
//
// No `className` escape hatch (M527 standing decision 3).

const FORGE_PATHS: Record<string, string> = {
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  gitlab:
    "m23.6 9.593-.034-.086L20.3.98a.85.85 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.537L5.332 1.07a.857.857 0 0 0-.29-.442.875.875 0 0 0-1-.053.858.858 0 0 0-.336.405L.433 9.502l-.033.086a6.066 6.066 0 0 0 2.012 7.01l.011.01.03.021 4.976 3.726 2.462 1.864 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.462-1.864 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003Z",
};

/** Whether `kind` has a mark to draw. Call sites use this to decide whether to
 * render the hairline separator that sits beside the mark — without it they
 * would draw a separator next to nothing. */
export function hasForgeMark(kind: string | null | undefined): boolean {
  return !!kind && kind in FORGE_PATHS;
}

export function ForgeMark({
  kind,
  size = 14,
}: {
  /** The forge the session's origin resolves to — `forgeKind` from the forge
   * read path. `"github"` is the only adapter today. */
  kind: string | null | undefined;
  /** Pixel size, like a lucide icon's `size`. 11 in chips, 14 in buttons. */
  size?: number;
}) {
  const d = kind ? FORGE_PATHS[kind] : undefined;
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}
