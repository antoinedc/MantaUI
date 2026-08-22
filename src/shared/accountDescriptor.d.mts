// Hand-written type declarations for accountDescriptor.mjs. The implementation
// is plain JS so it can be imported by both Node-side modules (.mjs natively,
// .ts via Bundler resolution) and the renderer/test suites. Keep this in sync
// with src/shared/accountDescriptor.mjs.

export type BalanceSign = "positive-is-credit" | "positive-is-debt";

export type DescriptorWindow = {
  kind: string;
  label: string;
  pct?: string;
  used?: string;
  limit?: string;
  remaining?: string;
  resetsAt?: string;
  startedAt?: string;
};

export type AccountDescriptor = {
  id: string;
  providerIDs: string[];
  url: string;
  auth: "bearer";
  kind?: "subscription" | "credit";
  balance: { path: string; minusPath?: string; units: string; sign: BalanceSign };
  windows?: DescriptorWindow[];
  planLabel?: string;
  overagePrice?: string;
};

export type DescriptorResult =
  | { valid: true; descriptor: AccountDescriptor }
  | { valid: false; errors: string[] };

export function validateDescriptor(raw: unknown): DescriptorResult;

export function readDescriptor(
  descriptor: AccountDescriptor,
  payload: unknown,
  nowMs: number,
): Record<string, unknown>;
