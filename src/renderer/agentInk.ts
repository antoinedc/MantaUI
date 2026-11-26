// The ink an agent's initials are drawn in. The badge's fill is the agent's OWN colour (agent.md `color`: a hex, rgb() or the
// oklch() the built-ins use), the same in both themes, so a fixed white — or the theme's `on-accent`, which flips with the theme —
// can fall under 4.5:1 on a mid-light colour (the demo's green is 3.4:1 under white). The ink is whichever of two fixed inks
// reads better on that colour. A colour this can't read keeps the theme's own ink (`null`).

export const AGENT_INK_LIGHT = "#ffffff";
export const AGENT_INK_DARK = "#0b1020";

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminanceOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b; // linear-light channels, 0–1

function fromHex(text: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const ch = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  return luminanceOf(ch[0], ch[1], ch[2]);
}

function fromRgb(text: string): number | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*[\d.%]+\s*)?\)$/i.exec(text);
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map((v) => srgbToLinear(clamp01(Number(v) / 255)));
  return luminanceOf(ch[0], ch[1], ch[2]);
}

/** `oklch(62% 0.14 160)` → linear sRGB (Björn Ottosson's OKLab matrices), clamped into gamut. */
function fromOklch(text: string): number | null {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.%]+\s*)?\)$/i.exec(text);
  if (!m) return null;
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  if (![L, C, h].every(Number.isFinite)) return null;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return luminanceOf(
    clamp01(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  );
}

/** WCAG relative luminance (0–1) of a CSS colour written as hex, rgb() or oklch(); null for anything else. */
export function colorLuminance(color: string | null | undefined): number | null {
  const text = String(color ?? "").trim();
  if (!text) return null;
  return fromHex(text) ?? fromRgb(text) ?? fromOklch(text);
}

/** The WCAG contrast ratio of `ink` (a hex) on `color`; null when `color` can't be read. */
export function inkContrast(color: string, ink: string): number | null {
  const bg = colorLuminance(color);
  const fg = colorLuminance(ink);
  if (bg == null || fg == null) return null;
  const [hi, lo] = bg >= fg ? [bg, fg] : [fg, bg];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of the two inks reads better on `color`; null when the colour can't be read (the caller keeps the theme's ink). */
export function agentInk(color: string | null | undefined): string | null {
  const text = String(color ?? "").trim();
  const light = text ? inkContrast(text, AGENT_INK_LIGHT) : null;
  const dark = text ? inkContrast(text, AGENT_INK_DARK) : null;
  if (light == null || dark == null) return null;
  return dark > light ? AGENT_INK_DARK : AGENT_INK_LIGHT;
}
