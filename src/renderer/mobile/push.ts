// push.ts — client side of Web Push for the mobile PWA.
//
// Registers the service worker (/sw.js), subscribes via the server's VAPID
// key, and ships the PushSubscription to the box. Also reports "focus" (which
// session is on screen + whether the app is visible) so the server can
// suppress the "Claude is done" push for the session the user is watching.
//
// Everything is best-effort and guarded: Web Push needs a secure context
// (HTTPS — the cloudflare tunnel is fine) AND, on iOS, the PWA must be
// installed to the home screen (iOS 16.4+). On unsupported setups the calls
// resolve to a clear state instead of throwing into the UI.

import { serverBase } from "../api/httpApi";

export type PushState = "unsupported" | "denied" | "default" | "granted";

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): PushState {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission as PushState;
}

// VAPID public key (base64url) → Uint8Array for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Back the view with a concrete ArrayBuffer so the type is
  // Uint8Array<ArrayBuffer> (what BufferSource/applicationServerKey wants;
  // a bare `new Uint8Array(n)` infers ArrayBufferLike under TS 5.7+).
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  // Relative path so it registers same-origin as the served page, scope "/".
  return navigator.serviceWorker.register("sw.js");
}

/** Mint a brand-new PushSubscription from the server's VAPID key. */
async function createSubscription(
  reg: ServiceWorkerRegistration,
): Promise<PushSubscription> {
  const res = await fetch(`${serverBase()}/push/vapid`);
  if (!res.ok) throw new Error(`vapid fetch failed: ${res.status}`);
  const { key } = (await res.json()) as { key: string };
  if (!key) throw new Error("server returned no VAPID key");
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
}

/** Upload a subscription to the box so the server can push to it. */
async function uploadSubscription(sub: PushSubscription): Promise<void> {
  const subRes = await fetch(`${serverBase()}/push/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub),
  });
  if (!subRes.ok) throw new Error(`subscribe upload failed: ${subRes.status}`);
}

/**
 * Drop the current local subscription (if any) and tell the server to forget
 * its endpoint. Used by both disable and the re-subscribe self-heal path.
 */
async function dropSubscription(
  reg: ServiceWorkerRegistration,
): Promise<void> {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch(`${serverBase()}/push/unsubscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * Request permission (must be called from a user gesture on iOS) and create +
 * upload a push subscription. Returns the resulting permission state.
 *
 * Reuses an existing local subscription if present — fast path for a first
 * enable. To recover from a STALE/ghost subscription (iOS silently invalidated
 * it but Apple still 201s the dead endpoint, so it can't be auto-detected), use
 * `resubscribePush()` instead, which forces a fresh endpoint.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm as PushState;

  const reg = await getRegistration();
  // SW must be active before subscribe() on some browsers.
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await createSubscription(reg);
  await uploadSubscription(sub);
  return "granted";
}

/**
 * Force a fresh subscription: drop any existing (possibly stale/ghost) local
 * subscription first, then mint and upload a new one. This is the self-heal for
 * the case where iOS rotated/invalidated the subscription on-device — Apple
 * keeps returning 201 to the dead endpoint, so the server can't detect it and
 * a plain `enablePush()` would just re-upload the same dead endpoint. Always
 * yields a new endpoint that the device actually honors.
 */
export async function resubscribePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm as PushState;

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  await dropSubscription(reg);
  const sub = await createSubscription(reg);
  await uploadSubscription(sub);
  return "granted";
}

/** Remove the local subscription and tell the server to forget it. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await dropSubscription(reg);
  } catch {
    /* best-effort */
  }
}

/** True if a live push subscription already exists (so the toggle can reflect
 *  reality, not just Notification.permission). */
export async function hasActiveSubscription(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Report which session is on screen and whether the app is visible. The server
 * suppresses the "done" push for a session the user is actively viewing.
 * Best-effort; uses keepalive so it still flushes during pagehide.
 */
export function reportFocus(sessionId: string | null, visible: boolean): void {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  try {
    const url = `${serverBase()}/push/focus`;
    const body = JSON.stringify({ sessionId, visible });
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* serverBase() can throw if unconfigured — ignore */
  }
}
