// planMockups.mjs — ONE shared detector for mockup-page references in plan
// markdown (BET-985). Consumed by the plan page renderer now, and by the
// renderer's PlanCard later — a single source so both agree on what a mockup
// is. Pure regex/string, no dependencies, never throws.

/**
 * The `/pages/<sub>` mockup references in a plan's markdown, in document order.
 */
export function extractPlanMockups(markdown) {
  if (typeof markdown !== "string") return [];
  const seen = new Set();
  const out = [];
  const source = String(markdown);
  const add = (rawTitle, url) => {
    const resolved = resolveMockup(url);
    if (!resolved) return;
    if (seen.has(resolved.url)) return;
    seen.add(resolved.url);
    const title = (rawTitle && rawTitle.trim()) || resolved.sub;
    out.push({ title, url: resolved.url, sub: resolved.sub });
  };

  // Markdown image links `![alt](url)` and links `[text](url)`, in document
  // order. Tolerate surrounding spaces; the URL may be a bare https URL.
  const linkRe =
    /!\[([^\]]*)\]\(\s*([^)]+?)\s*\)|(?<!!)\[([^\]]*)\]\(\s*([^)]+?)\s*\)/g;
  let m;
  while ((m = linkRe.exec(source))) {
    const isImage = m[1] !== undefined;
    add(isImage ? m[1] : m[3], isImage ? m[2] : m[4]);
  }

  // Bare URLs on their own line whose host-path contains `/pages/`.
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!/^\S+\/pages\/\S*$/.test(trimmed)) continue;
    if (/^!?\[/.test(trimmed)) continue;
    add("", trimmed);
  }

  return out;
}

// A mockup iff the URL path (after `scheme://host`) starts with `/pages/` and
// has a non-empty sub. Returns `{ url, sub }` or null. `sub` = the path
// segment after `/pages/`, trailing slash stripped, lowercased.
function resolveMockup(url) {
  const s = String(url).trim();
  if (!s) return null;
  let path = s;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(s);
  if (scheme) {
    path = s.slice(scheme[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return null;
  }
  if (!path.startsWith("/pages/")) return null;
  let sub = path.slice("/pages/".length);
  if (sub.endsWith("/")) sub = sub.slice(0, -1);
  if (!sub) return null;
  return { url: s, sub: sub.toLowerCase() };
}
