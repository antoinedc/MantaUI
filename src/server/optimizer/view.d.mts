// Types for the box's optimizer render-model functions, so the renderer's card
// tests can run the real producer over their fixtures (see OptimizerCard.test.tsx).
export function summaryView(summary: unknown, opts?: { optimizerEnabled?: boolean }): unknown;
export function seriesView(series: unknown, opts?: { range?: string }): unknown;
