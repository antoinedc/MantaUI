// ===== URL detection for transcript text =====
//
// Pure (no React). Wraps ONE configured linkify-it instance and layers the
// transcript's own rules on top; see docs/superpowers/specs/2026-10-29-transcript-autolink.md.

import { LinkifyIt } from "linkify-it";

export type LinkMatch = { start: number; end: number; text: string; href: string };

export type FindLinksOptions = {
  // true (default): schemeless hosts link too. false: only http(s):// and www.
  // "whole": schemeless links only when the whole trimmed text is ONE link
  // (inline code: `mantaui.com` is a link, `curl mantaui.com` is a command).
  schemeless?: boolean | "whole";
};

// Schemeless TLDs. linkify-it's default list treats every 2-letter ccTLD as
// valid, which collides with file extensions (install.sh, main.py, lib.rs).
const SCHEMELESS_TLDS = new Set(
  "com net org io dev app ai co me so gg xyz info biz edu gov tech cloud site page run eu uk de fr ca us".split(" "),
);
// These double as file extensions (MantaUI.app, logo.ai): link only with a path.
const NEEDS_PATH_TLDS = new Set(["app", "ai"]);

// Every 2-letter code is handed to linkify-it so `www.` hosts on any ccTLD
// still match; the allowlist above is enforced on schemeless matches afterwards.
const TWO_LETTER: string[] = [];
for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) TWO_LETTER.push(String.fromCharCode(a, b));

const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false, fuzzyIP: false }).tlds([
  ...SCHEMELESS_TLDS,
  ...TWO_LETTER,
]);

// A schemeless match preceded by one of these (or a word character) is part of
// a path, identifier or address, not a web address.
const REJECT_BEFORE = new Set(["/", "\\", ".", "@", "~", "-", "_", "$", ":"]);
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const PLACEHOLDER_AFTER = new Set(["<", "{", "$"]);
// Raw-markdown wrappers that stop linkify-it seeing a URL start: backticks
// anywhere, and these when they sit directly in front of a scheme / www.
const WRAPPER_BEFORE_URL = /[=*^+|~](?=https?:\/\/|www\.)/gi;
const TRAILING_WRAPPERS = new Set(["`", "*", "|", "^"]);
// Cheap guard: no scheme and no `x.y` shape means no link at all.
const MAYBE_LINK = /https?:\/\/|[\p{L}\p{N}]\.[\p{L}]/iu;

function lastCodePoint(s: string): string {
  return s.length >= 2 && /[\uDC00-\uDFFF]/.test(s[s.length - 1]) ? s.slice(-2) : s.slice(-1);
}

function schemelessAllowed(text: string, start: number, matchText: string): boolean {
  if (start > 0) {
    const prev = lastCodePoint(text.slice(Math.max(0, start - 2), start));
    if (REJECT_BEFORE.has(prev) || WORD_CHAR.test(prev)) return false;
  }
  const hostEnd = matchText.search(/[/?#]/);
  const host = hostEnd === -1 ? matchText : matchText.slice(0, hostEnd);
  const tld = host.split(".").pop()?.toLowerCase() ?? "";
  if (!SCHEMELESS_TLDS.has(tld)) return false;
  return !NEEDS_PATH_TLDS.has(tld) || matchText[hostEnd] === "/";
}

export function findLinks(text: string, opts: FindLinksOptions = {}): LinkMatch[] {
  const schemeless = opts.schemeless ?? true;
  if (!text || !MAYBE_LINK.test(text)) return [];
  // Same length as `text`, so match indices apply to the original.
  const scan = text.replace(/`/g, " ").replace(WRAPPER_BEFORE_URL, " ");
  const raw = linkify.match(scan);
  if (!raw) return [];
  const out: LinkMatch[] = [];
  for (const m of raw) {
    const isScheme = m.schema === "http:" || m.schema === "https:";
    const isWww = m.schema === "" && /^www\./i.test(m.raw);
    if (!isScheme && !isWww && m.schema !== "") continue;
    const next = text[m.lastIndex];
    if (next && (PLACEHOLDER_AFTER.has(next) || (next === ":" && PLACEHOLDER_AFTER.has(text[m.lastIndex + 1] ?? "")))) continue;
    if (!isScheme && !isWww) {
      if (!schemeless || !schemelessAllowed(text, m.index, m.raw)) continue;
    }
    let end = m.lastIndex;
    while (end > m.index && TRAILING_WRAPPERS.has(text[end - 1])) end--;
    const slice = text.slice(m.index, end);
    out.push({ start: m.index, end, text: slice, href: isScheme ? slice : `https://${slice}` });
  }
  if (schemeless === "whole") return keepWholeSpanSchemeless(text, out);
  return out;
}

function keepWholeSpanSchemeless(text: string, links: LinkMatch[]): LinkMatch[] {
  const isFuzzy = (l: LinkMatch) => !/^(https?:\/\/|www\.)/i.test(l.text);
  if (!links.some(isFuzzy)) return links;
  const lead = text.length - text.trimStart().length;
  const stop = text.trimEnd().length;
  const whole = links.length === 1 && links[0].start === lead && links[0].end === stop;
  return whole ? links : links.filter((l) => !isFuzzy(l));
}
