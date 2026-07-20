// Hand-written type declarations for logShip.mjs. Implementation is plain
// JS so it can be imported by Node-side modules (.mjs natively, .ts via
// Bundler resolution) and the renderer test suite (vitest .ts file).
// Keep this in sync with src/shared/logShip.mjs.

export interface AxiomConfig {
  endpoint: string;
  token: string;
}

export interface ResolveAxiomConfigArgs {
  env: Record<string, string | undefined>;
  config: { axiomToken?: string; axiomDataset?: string; shareAnalytics?: boolean } | null;
}

export function resolveAxiomConfig(args: ResolveAxiomConfigArgs): AxiomConfig | null;

export function formatConsoleArgs(args: unknown[]): string;

export interface LogShipper {
  log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
  flush(): Promise<void>;
  stop(): void;
  pending(): number;
}

export interface CreateLogShipperOptions {
  endpoint: string;
  token: string;
  source: "mobile" | "desktop" | "server" | "relay";
  device: string;
  fetchFn?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; [k: string]: unknown }) => Promise<{ ok: boolean; status?: number }>;
  now?: () => number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  flushMs?: number;
  maxBatch?: number;
  maxBuffer?: number;
}

export function createLogShipper(opts: CreateLogShipperOptions): LogShipper;

export interface ShipperLike {
  log: LogShipper["log"];
}

export function captureConsole(shipper: ShipperLike): () => void;
