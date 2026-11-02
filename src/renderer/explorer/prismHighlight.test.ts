import { describe, expect, it } from "vitest";
import { tags } from "@lezer/highlight";
import { themes } from "prism-react-renderer";
import { PRISM_TAG_GROUPS, prismThemeSpecs, prismThemeToHighlightStyle } from "./prismHighlight";

type Spec = { tag: unknown; color?: string; fontStyle?: string; fontWeight?: string };

function specFor(theme: typeof themes.vsDark, tag: unknown): Spec | undefined {
  return (prismThemeSpecs(theme) as Spec[]).find((s) => (Array.isArray(s.tag) ? s.tag.includes(tag) : s.tag === tag));
}

// Colours below are read off the themes' own tables (language-agnostic entries,
// later entries win), not off the adapter.
const DARK = {
  comment: "rgb(106, 153, 85)",
  keyword: "rgb(86, 156, 214)",
  string: "rgb(206, 145, 120)",
  fn: "rgb(220, 220, 170)",
  number: "rgb(181, 206, 168)",
  constant: "rgb(100, 102, 149)",
  className: "rgb(78, 201, 176)",
  tag: "rgb(78, 201, 176)",
  attrName: "rgb(156, 220, 254)",
  operator: "rgb(212, 212, 212)",
  punctuation: "rgb(212, 212, 212)",
};
const LIGHT = {
  comment: "#999988",
  string: "#e3116c",
  keyword: "#00009f",
  fn: "#d73a49",
  number: "#36acaa",
  bool: "#36acaa",
  property: "#36acaa",
  regex: "#36acaa",
  url: "#36acaa",
  tag: "#00009f",
  attrName: "#00a4db",
  operator: "#393A34",
  punctuation: "#393A34",
};

describe("prismThemeToHighlightStyle", () => {
  it("maps the Prism types to the contract's lezer tags with vsDark's colours", () => {
    const t = themes.vsDark;
    expect(specFor(t, tags.comment)?.color).toBe(DARK.comment);
    expect(specFor(t, tags.string)?.color).toBe(DARK.string);
    expect(specFor(t, tags.special(tags.string))?.color).toBe(DARK.string);
    for (const k of [tags.keyword, tags.controlKeyword, tags.modifier]) expect(specFor(t, k)?.color).toBe(DARK.keyword);
    expect(specFor(t, tags.function(tags.variableName))?.color).toBe(DARK.fn);
    expect(specFor(t, tags.function(tags.propertyName))?.color).toBe(DARK.fn);
    expect(specFor(t, tags.number)?.color).toBe(DARK.number);
    // vsDark has no `boolean` entry: the group falls back to `constant`.
    for (const k of [tags.bool, tags.atom, tags.constant(tags.variableName)]) expect(specFor(t, k)?.color).toBe(DARK.constant);
    expect(specFor(t, tags.operator)?.color).toBe(DARK.operator);
    expect(specFor(t, tags.punctuation)?.color).toBe(DARK.punctuation);
    expect(specFor(t, tags.bracket)?.color).toBe(DARK.punctuation);
    for (const k of [tags.className, tags.typeName, tags.standard(tags.variableName)]) {
      expect(specFor(t, k)?.color).toBe(DARK.className);
    }
    expect(specFor(t, tags.tagName)?.color).toBe(DARK.tag);
    expect(specFor(t, tags.attributeName)?.color).toBe(DARK.attrName);
  });

  it("maps the same tags with github's colours (later entries win)", () => {
    const t = themes.github;
    expect(specFor(t, tags.comment)?.color).toBe(LIGHT.comment);
    expect(specFor(t, tags.comment)?.fontStyle).toBe("italic");
    expect(specFor(t, tags.string)?.color).toBe(LIGHT.string);
    expect(specFor(t, tags.keyword)?.color).toBe(LIGHT.keyword);
    expect(specFor(t, tags.function(tags.variableName))?.color).toBe(LIGHT.fn);
    expect(specFor(t, tags.number)?.color).toBe(LIGHT.number);
    expect(specFor(t, tags.bool)?.color).toBe(LIGHT.bool);
    expect(specFor(t, tags.propertyName)?.color).toBe(LIGHT.property);
    expect(specFor(t, tags.regexp)?.color).toBe(LIGHT.regex);
    expect(specFor(t, tags.url)?.color).toBe(LIGHT.url);
    expect(specFor(t, tags.link)?.color).toBe(LIGHT.url);
    expect(specFor(t, tags.tagName)?.color).toBe(LIGHT.tag);
    expect(specFor(t, tags.attributeName)?.color).toBe(LIGHT.attrName);
    expect(specFor(t, tags.operator)?.color).toBe(LIGHT.operator);
    expect(specFor(t, tags.punctuation)?.color).toBe(LIGHT.punctuation);
  });

  it("ignores language-specific entries (vsDark punctuation for markup)", () => {
    expect(specFor(themes.vsDark, tags.punctuation)?.color).not.toBe("#808080");
  });

  it("gives headings, bold and italic their weight/style when the theme is silent", () => {
    for (const t of [themes.vsDark, themes.github]) {
      expect(specFor(t, tags.heading)?.fontWeight).toBe("bold");
      expect(specFor(t, tags.strong)?.fontWeight).toBe("bold");
      expect(specFor(t, tags.emphasis)?.fontStyle).toBe("italic");
    }
  });

  it("emits a spec per mapped group whose types the theme colours, and none for the rest", () => {
    for (const t of [themes.vsDark, themes.github]) {
      const emitted = prismThemeSpecs(t) as Spec[];
      for (const group of PRISM_TAG_GROUPS) {
        const present = emitted.some((s) => Array.isArray(s.tag) && s.tag[0] === group.tags[0]);
        const colored = group.types.some((type) =>
          t.styles.some((e) => !e.languages?.length && e.types.includes(type) && "color" in e.style),
        );
        if (colored || group.defaults) expect(present, group.types.join("/")).toBe(true);
        else expect(present, group.types.join("/")).toBe(false);
      }
    }
  });

  it("flips with the theme: the two styles differ and both are real HighlightStyles", () => {
    const dark = prismThemeToHighlightStyle(themes.vsDark);
    const light = prismThemeToHighlightStyle(themes.github);
    expect(dark.specs.length).toBeGreaterThan(8);
    expect(light.specs.length).toBeGreaterThan(8);
    expect(specFor(themes.vsDark, tags.comment)?.color).not.toBe(specFor(themes.github, tags.comment)?.color);
  });

  it("never reads the theme's plain colour or background", () => {
    const hexes = (prismThemeSpecs(themes.vsDark) as Spec[]).map((s) => s.color);
    expect(hexes).not.toContain(themes.vsDark.plain.backgroundColor);
    expect(hexes).not.toContain(themes.vsDark.plain.color);
  });
});
