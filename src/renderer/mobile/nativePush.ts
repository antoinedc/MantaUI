// nativePush.ts — APNs native-push registration for the iOS Capacitor app
// (BET-181, §3.3). Supplementary to push.ts (Web Push VAPID for the frozen
// PWA); NOT a replacement. The frozen PWA build never has Capacitor, so
// the Web Push leg stays untouched. Native app uses Capacitor's
// @capacitor/push-notifications plugin to get an APNs device token,
// registers it with the box server (POST /push/register-apns via the
// standard 6-site pattern), and routes a tapped notification through the
// EXISTING pendingNotif ref in MobileApp.tsx — same path the Web Push
// service-worker message handler uses, so deep-link resolution is shared.
//
// All Web Push logic is unchanged.

// Loose, locally-declared shape of the @capacitor/push-notifications plugin
// surface. We declare just what we use so the file stays typecheck-clean
// without taking a hard runtime dependency on the plugin's types (the npm
// dep is declared in mobile/package.json but the web bundler doesn't
// resolve it — Capacitor injects the plugin at runtime via the native
// bridge). Kept in this file so the surface is auditable.
interface PushRegistration {
  value: string; // the APNs device token (hex string)
}
interface PushNotificationData {
  sessionId?: string;
  [k: string]: unknown;
}
interface PushNotification {
  title?: string;
  body?: string;
  data?: PushNotificationData;
  // iOS exposes the actionId of any tapped notification action button on
  // the SAME payload (no separate "action" field); default tap = "default".
  actionId?: string;
}
interface PushActionPerformedEvent {
  notification: PushNotification;
  actionId?: string; // iOS only — defaults to "default" for body taps
}
interface PushNotificationsPlugin {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<{ registrationId: string }>;
  addListener(
    event: "registration",
    cb: (token: PushRegistration) => void,
  ): Promise<unknown> | unknown;
  addListener(
    event: "pushNotificationActionPerformed",
    cb: (event: PushActionPerformedEvent) => void,
  ): Promise<unknown> | unknown;
}

// Capacitor injects `window.Capacitor?.Plugins?.PushNotifications` at runtime
// on the native iOS / Android shell. The webview build doesn't have it, so
// every entry point here is feature-guarded — the function silently no-ops
// on a vanilla browser / frozen PWA build.
declare global {
  interface Window {
    Capacitor?: {
      Plugins?: {
        PushNotifications?: PushNotificationsPlugin;
      };
    };
  }
}

/** True when the @capacitor/push-notifications plugin is available on the
 *  window — i.e. this app is running inside the native Capacitor shell. */
export function isNativePushAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.Capacitor?.Plugins?.PushNotifications
  );
}

/** Shared ref for the in-process Capacitor→MobileApp notification tap
 *  bridge. MobileApp watches `manta-native-notif-tap` events on window
 *  and routes them into the same `pendingNotif` mechanism the Web Push
 *  service-worker message handler uses. Dispatching as a CustomEvent
 *  (not a service-worker MessageEvent) is correct here: the native app
 *  has no service worker, and a CustomEvent doesn't need one. */
const NATIVE_NOTIF_TAP_EVENT = "manta-native-notif-tap";

/** Extract sessionId from an APNs push payload (set by the server via
 *  push.mjs buildApnsPayload). Best-effort: any non-string / missing
 *  field resolves to null so the listener can early-out. */
function extractSessionId(payload: PushNotification): string | null {
  const sid = payload?.data?.sessionId;
  return typeof sid === "string" && sid ? sid : null;
}

/**
 * Register for APNs native push on the Capacitor app. Steps:
 *   1. requestPermissions()  (must be from a user gesture on iOS)
 *   2. register() → fires the `registration` event with the device token
 *   3. POST the token to /push/register-apns via window.api.pushRegisterApns
 *   4. subscribe to `pushNotificationActionPerformed`; route the tap's
 *      sessionId through the same pendingNotif mechanism MobileApp uses
 *      for the Web Push deep-link (see MobileApp.tsx openSessionForNotif).
 *
 * All steps are best-effort: a permission denial or a server error is
 * logged, never thrown (the app continues to work; the user simply
 * doesn't get backgrounded pushes). Re-runs are safe (the server's
 * addApnsToken de-dupes on the token value).
 */
export async function registerApns(): Promise<{ ok: boolean; reason?: string }> {
  if (!isNativePushAvailable()) return { ok: false, reason: "unavailable" };
  const plugin = window.Capacitor!.Plugins!.PushNotifications!;

  // 1. Permission — best-effort.
  let perm: { receive: string };
  try {
    perm = await plugin.requestPermissions();
  } catch (e) {
    console.warn("[nativePush] requestPermissions failed:", e);
    return { ok: false, reason: "permission-failed" };
  }
  if (perm?.receive !== "granted") {
    return { ok: false, reason: "permission-denied" };
  }

  // 2. Token registration. Listeners added BEFORE register() so we don't
  //    miss the (fire-once-then-silent) registration event on iOS.
  await plugin.addListener("registration", (token) => {
    const v = typeof token?.value === "string" ? token.value : "";
    if (!v) {
      console.warn("[nativePush] registration event with empty token");
      return;
    }
    void uploadToken(v);
  });

  await plugin.addListener("pushNotificationActionPerformed", (event) => {
    const sid = extractSessionId(event?.notification);
    if (!sid) {
      console.warn("[nativePush] tap without sessionId; ignoring");
      return;
    }
    // Route through the SAME mechanism MobileApp uses for the Web Push
    // service-worker deep-link. The pendingNotif ref + resolveSessionOwner
    // + openSessionForNotif dance is the single source of truth for
    // "navigate to a session because of a notification tap". We don't add
    // a parallel resolution path.
    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIF_TAP_EVENT, { detail: { sessionId: sid } }),
    );
  });

  // 3. Trigger registration.
  try {
    await plugin.register();
  } catch (e) {
    console.warn("[nativePush] register() failed:", e);
    return { ok: false, reason: "register-failed" };
  }
  return { ok: true };
}

/** POST the APNs device token to the box (6-site pattern →
 *  /rpc/push:register-apns → push.addApnsToken). Never throws — failures
 *  are logged and swallowed. */
async function uploadToken(token: string): Promise<void> {
  const api = (window as Window & { api?: { pushRegisterApns?: (t: string) => Promise<{ ok: boolean; count: number }> } }).api;
  if (!api?.pushRegisterApns) {
    console.warn("[nativePush] window.api.pushRegisterApns not available");
    return;
  }
  try {
    const res = await api.pushRegisterApns(token);
    console.log(`[nativePush] registered token count=${res?.count ?? "?"}`);
  } catch (e) {
    console.warn("[nativePush] pushRegisterApns failed:", e);
  }
}

/** Exported for MobileApp to wire its own listener. Internal — not part
 *  of the public API; only MobileApp should consume this event name. */
export const NATIVE_NOTIF_TAP_EVENT_NAME = NATIVE_NOTIF_TAP_EVENT;
