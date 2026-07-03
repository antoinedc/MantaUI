// useQrScanner.ts — thin, browser-safe wrapper over the native camera QR
// scanner (BET-74, M3.2). Bridges the desktop's "Pair phone" QR into the mobile
// pairing flow: check/request camera permission → open the camera → return the
// decoded string (or a typed failure the PairingScreen can render inline).
//
// ARCHITECTURE: the mobile client is the shipped Capacitor web bundle
// (mobile/www/), NOT a React Native app. The barcode plugin
// (@capacitor-community/barcode-scanner) is a NATIVE plugin: it is present only
// inside the Android/iOS shell, where Capacitor registers it on the global
// `window.Capacitor.Plugins` registry at runtime. In a plain browser (dev, PWA)
// the plugin is absent — so we resolve it through that runtime registry rather
// than a static `import`. This keeps the renderer bundle buildable/typecheckable
// WITHOUT the plugin installed at the repo root (it lives in mobile/package.json
// only) and lets the hook degrade to "unavailable" everywhere the native camera
// isn't reachable, never throwing.
//
// The decision logic (permission state + raw scan result → outcome) is the pure
// `classifyScanOutcome` helper, exported and unit-tested; the hook itself owns
// only the plugin lookup + the async plumbing.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a scan did not yield a decoded string:
 *   • "denied"      — the user refused the camera permission prompt.
 *   • "unavailable" — no native scanner reachable (plain browser / PWA, plugin
 *                     absent, or the platform threw). The user should type the
 *                     code manually.
 *   • "cancelled"   — the camera opened but the user backed out without scanning.
 */
export type ScanFailure = "denied" | "unavailable" | "cancelled";

/** A successful scan carries the raw decoded string (still unvalidated). */
export type ScanResult =
  | { ok: true; value: string }
  | { ok: false; reason: ScanFailure };

// The subset of the @capacitor-community/barcode-scanner permission state we
// branch on. `granted` → proceed; `denied`/`neverAsked`/`restricted`/`unknown`
// (and an absent value) → treat as denied.
export interface ScanPermissionState {
  granted?: boolean;
  denied?: boolean;
  asked?: boolean;
  neverAsked?: boolean;
  restricted?: boolean;
  unknown?: boolean;
}

// The subset of a startScan() result we care about: `hasContent` gates whether
// `content` is a real decode. A false/absent `hasContent` means the user
// cancelled (backed out of the camera).
export interface ScanRawResult {
  hasContent?: boolean;
  content?: string;
}

// ---------------------------------------------------------------------------
// Pure decision helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Map a (rawResult, permissionState) pair to a typed {@link ScanResult}. Pure —
 * no plugin, no DOM — so the branch logic is unit-testable in isolation:
 *
 *   • permission not granted            → { ok:false, reason:"denied" }
 *   • granted + hasContent + non-empty  → { ok:true,  value:<trimmed content> }
 *   • granted + no content (user back)  → { ok:false, reason:"cancelled" }
 *
 * `raw` may be null when the scan itself couldn't run (caller passes null on a
 * plugin/platform throw); with a granted permission that reads as "cancelled",
 * but the hook maps a hard plugin failure to "unavailable" before ever calling
 * this — see useQrScanner below.
 */
export function classifyScanOutcome(
  raw: ScanRawResult | null,
  permState: ScanPermissionState | null,
): ScanResult {
  if (!permState || permState.granted !== true) {
    return { ok: false, reason: "denied" };
  }
  const content = typeof raw?.content === "string" ? raw.content.trim() : "";
  if (raw?.hasContent === true && content.length > 0) {
    return { ok: true, value: content };
  }
  return { ok: false, reason: "cancelled" };
}

// ---------------------------------------------------------------------------
// Runtime plugin lookup (native-only; absent in a plain browser)
// ---------------------------------------------------------------------------

// Minimal structural type for the plugin methods we call. Kept local so the
// renderer neither imports nor depends on the plugin package at build time.
interface BarcodeScannerPlugin {
  checkPermission(opts: { force: boolean }): Promise<ScanPermissionState>;
  hideBackground?(): Promise<void>;
  showBackground?(): Promise<void>;
  startScan(opts?: unknown): Promise<ScanRawResult>;
  stopScan?(): Promise<void>;
  prepare?(): Promise<void>;
}

interface CapacitorGlobal {
  Plugins?: { BarcodeScanner?: BarcodeScannerPlugin };
  isNativePlatform?: () => boolean;
}

/**
 * Resolve the native BarcodeScanner plugin from the Capacitor runtime registry,
 * or null when it isn't reachable (plain browser / PWA / plugin not installed
 * in the shell). Never throws.
 */
function getBarcodeScanner(): BarcodeScannerPlugin | null {
  try {
    const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
    if (!cap) return null;
    // On web, isNativePlatform() is false and the native plugin is a no-op stub;
    // treat that as unavailable so we fall back to manual entry cleanly.
    if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) {
      return null;
    }
    return cap.Plugins?.BarcodeScanner ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Run one QR scan. Returns a decoded string on success or a typed failure the
 * caller renders inline. Guarantees:
 *   • plugin absent (browser/PWA)   → { ok:false, reason:"unavailable" }
 *   • camera permission refused     → { ok:false, reason:"denied" }
 *   • camera opened, user backed out→ { ok:false, reason:"cancelled" }
 *   • any thrown error              → { ok:false, reason:"unavailable" }
 * Never throws.
 *
 * Not a stateful React hook (no useState) — it's an async action the component
 * awaits on a button tap. Named `useQrScanner` per the issue's file contract and
 * to signal it's the mobile scan seam; it's safe to call outside render.
 */
export async function useQrScanner(): Promise<ScanResult> {
  const scanner = getBarcodeScanner();
  if (!scanner) return { ok: false, reason: "unavailable" };

  try {
    // force:true triggers the OS permission prompt on first use.
    const perm = await scanner.checkPermission({ force: true });
    if (perm?.granted !== true) {
      // Explicit refusal vs. never-decided both surface as "denied" — either
      // way the camera won't open, so the user should type the code.
      return { ok: false, reason: "denied" };
    }

    // Make the WebView transparent so the camera preview shows through, run the
    // scan, then always restore the background (even on throw) so a failed scan
    // never leaves the pairing screen invisible.
    await scanner.prepare?.();
    await scanner.hideBackground?.();
    let raw: ScanRawResult;
    try {
      raw = await scanner.startScan();
    } finally {
      await scanner.showBackground?.().catch(() => {});
      await scanner.stopScan?.().catch(() => {});
    }
    return classifyScanOutcome(raw, perm);
  } catch {
    // Plugin/platform threw (camera busy, unsupported, teardown race) — degrade
    // to manual entry rather than surfacing a raw error.
    return { ok: false, reason: "unavailable" };
  }
}
