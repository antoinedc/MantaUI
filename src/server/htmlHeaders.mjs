// htmlHeaders.mjs — the ONE sandboxed-HTML response header builder.
//
// Both /pages/<sub> (servePage.mjs) and /widgets/<id> (widgets.mjs) serve a
// model-authored standalone HTML document on the box's own origin. That origin
// is shared with the real app (which holds the box_token), so every such
// response must carry the same defensive header set: a sandbox CSP that keeps
// the document in an opaque origin, `no-store`, `nosniff` and `no-referrer`.
//
// This is the single source of truth for those headers. The caller supplies
// its own CSP policy — servePage uses its long-standing `sandbox
// allow-scripts allow-forms allow-popups allow-modals` string (unchanged,
// pinned by test), widgets uses WIDGET_CSP — so there is exactly one place a
// header can be forgotten and no second HTML-serving code path.
export function sandboxedHtmlHeaders(csp) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
