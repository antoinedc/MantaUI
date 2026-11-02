// prismHighlight.ts — turns a prism-react-renderer theme into a CodeMirror
// HighlightStyle, so the Explorer's code view uses the SAME colours as the
// transcript's CodeBlock (contract E6, docs/screens/explorer/contract.md).
//
// The Prism theme owns the colours; this file owns only the mapping from Prism
// token types to @lezer/highlight tags. A type the theme gives no colour is
// left unstyled (it inherits the editor's --tx1), exactly as Prism leaves it.
// The theme's `plain` colours and background are ignored on purpose.

import { HighlightStyle } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import type { PrismTheme } from "prism-react-renderer";

type TagStyleSpec = { tag: Tag | readonly Tag[]; color?: string; fontStyle?: string; fontWeight?: string };

type Group = {
  /** Prism token types, in priority order — the first one the theme colours wins. */
  types: readonly string[];
  tags: readonly Tag[];
  /** Applied when the theme says nothing about the group's types. */
  defaults?: { fontStyle?: string; fontWeight?: string };
};

export const PRISM_TAG_GROUPS: readonly Group[] = [
  { types: ["comment", "prolog", "doctype", "cdata"], tags: [tags.comment] },
  { types: ["string", "char", "attr-value", "template-string"], tags: [tags.string, tags.special(tags.string)] },
  { types: ["keyword", "atrule", "important"], tags: [tags.keyword, tags.controlKeyword, tags.modifier] },
  { types: ["function"], tags: [tags.function(tags.variableName), tags.function(tags.propertyName)] },
  { types: ["number"], tags: [tags.number] },
  { types: ["boolean", "constant"], tags: [tags.bool, tags.atom, tags.constant(tags.variableName)] },
  { types: ["operator"], tags: [tags.operator] },
  { types: ["punctuation"], tags: [tags.punctuation, tags.bracket] },
  { types: ["property"], tags: [tags.propertyName] },
  { types: ["class-name", "builtin"], tags: [tags.className, tags.typeName, tags.standard(tags.variableName)] },
  { types: ["tag"], tags: [tags.tagName] },
  { types: ["attr-name"], tags: [tags.attributeName] },
  { types: ["regex"], tags: [tags.regexp] },
  { types: ["title"], tags: [tags.heading], defaults: { fontWeight: "bold" } },
  { types: ["bold"], tags: [tags.strong], defaults: { fontWeight: "bold" } },
  { types: ["italic"], tags: [tags.emphasis], defaults: { fontStyle: "italic" } },
  { types: ["url"], tags: [tags.url, tags.link] },
];

type ResolvedStyle = { color?: string; fontStyle?: string; fontWeight?: string };

/** The style a Prism theme gives ONE token type: every language-agnostic entry
 *  that names the type, merged in order (later entries win — Prism's own rule). */
export function prismTypeStyle(theme: PrismTheme, type: string): ResolvedStyle | null {
  let out: ResolvedStyle | null = null;
  for (const entry of theme.styles) {
    if (entry.languages && entry.languages.length > 0) continue;
    if (!entry.types.includes(type)) continue;
    const s = entry.style as Record<string, unknown>;
    out = { ...(out ?? {}) };
    if (typeof s.color === "string") out.color = s.color;
    if (typeof s.fontStyle === "string") out.fontStyle = s.fontStyle;
    if (typeof s.fontWeight === "string" || typeof s.fontWeight === "number") out.fontWeight = String(s.fontWeight);
  }
  return out;
}

/** The style for a group: the first type in priority order that the theme colours,
 *  else the first type that styles anything, else the group's defaults. */
export function prismGroupStyle(theme: PrismTheme, group: Group): ResolvedStyle | null {
  let firstStyled: ResolvedStyle | null = null;
  for (const type of group.types) {
    const s = prismTypeStyle(theme, type);
    if (!s) continue;
    if (s.color) return { ...group.defaults, ...s };
    firstStyled ??= s;
  }
  const merged = { ...group.defaults, ...firstStyled };
  return Object.keys(merged).length > 0 ? merged : null;
}

export function prismThemeSpecs(theme: PrismTheme): TagStyleSpec[] {
  const specs: TagStyleSpec[] = [];
  for (const group of PRISM_TAG_GROUPS) {
    const style = prismGroupStyle(theme, group);
    if (!style) continue;
    specs.push({ tag: group.tags, ...style });
  }
  return specs;
}

export function prismThemeToHighlightStyle(theme: PrismTheme): HighlightStyle {
  return HighlightStyle.define(prismThemeSpecs(theme));
}
