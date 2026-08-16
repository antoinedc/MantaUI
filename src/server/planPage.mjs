// planPage.mjs — the one shared HTML-escaping helper for plan pages (BET-1004).
//
// The markdown plan render/publish pipeline was retired — plan pages are now
// single-HTML only, handled by the manta-plan path (planRender.mjs +
// planDoc.mjs via /api/plan-render). All that survives here is `escapeHtml`,
// which planDoc.mjs still imports and uses to HTML-escape user-authored text
// into the rendered document.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
