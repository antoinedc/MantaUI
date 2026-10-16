// Declarations for v1EventsAsV2.mjs (test support used by the renderer harness).
export function createV1ToV2(): (ev: unknown) => unknown[];
export function v1EventToV2(ev: unknown, planCalls?: Set<string>): unknown[];
