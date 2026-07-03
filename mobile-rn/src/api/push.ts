// push.ts (impure) — the push-registration scaffold.
//
// Runs the registration flow proven for M3.5-3 (BET-78): request notification
// permission via expo-notifications, obtain the Expo push token, and hand it to
// `registerPushToken` — which POSTs it to the box push endpoint, OR is a NO-OP
// when no push backend is configured. That no-op path is deliberate: this slice
// ships + tests the whole flow with ZERO Apple credentials, on the simulator /
// Expo Go. It compiles and runs today; only LIVE native APNs delivery waits on
// the operator's APNs .p8 signing key.
//
// TODO(M5, human-blocked on APNs .p8 — see BET-75): configure `PushConfig.endpoint`
//   to the operated relay's registration URL and wire the APNs/FCM delivery leg
//   on the box/relay. Until then `isPushBackendConfigured` is false and this
//   flow resolves to `{ kind: "unconfigured" }` — the token is obtained but not
//   sent, which is exactly what we can prove without Apple artifacts.
//
// ALL decision logic (should-register, backend-configured, result
// classification, request body) lives in the pure ../pure/push module and is
// unit-tested there. THIS file owns only the expo-notifications + fetch side
// effects, injected so the flow is testable without a live APNs backend or a
// device — the same pure↔impure split as the rest of mobile-rn.

import {
  buildRegisterBody,
  classifyRegistration,
  isPushBackendConfigured,
  shouldRegister,
  type PushPermissionStatus,
  type PushRegistrationResult,
} from "../pure/push";

/** Push backend configuration. `endpoint` empty/absent ⇒ registration no-ops. */
export interface PushConfig {
  /**
   * The box/relay push-registration URL. Left empty until M5 wires the operated
   * push backend — so the default build degrades to a no-op registration.
   */
  endpoint?: string | null;
}

/**
 * The default (unconfigured) push backend. M5 replaces `endpoint` with the
 * operated relay's registration URL once the APNs .p8 is available. Exported so
 * a caller / test can see + override the current state.
 */
export const DEFAULT_PUSH_CONFIG: PushConfig = { endpoint: null };

/**
 * The subset of expo-notifications the scaffold touches. Injected so tests run
 * WITHOUT the native module (which can't load off-device). The default provider
 * lazily imports expo-notifications at call time.
 */
export interface NotificationsProvider {
  getPermissionsAsync(): Promise<{ status: string }>;
  requestPermissionsAsync(): Promise<{ status: string }>;
  getExpoPushTokenAsync(): Promise<{ data: string }>;
}

/** The platform tag sent with the token so the box routes APNs vs FCM (M5). */
export type PushPlatform = "ios" | "android" | "web";

export interface RegisterPushOptions {
  boxId: string;
  platform: PushPlatform;
  /** Backend config; defaults to the unconfigured (no-op) config. */
  config?: PushConfig;
  /** expo-notifications shim; defaults to the real lazy-loaded module. */
  notifications?: NotificationsProvider;
  /** fetch impl; defaults to global fetch. Injected for tests. */
  fetchFn?: typeof fetch;
}

/** Normalize expo's permission string into our pure status. */
function normalizeStatus(status: string): PushPermissionStatus {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "undetermined";
}

/**
 * Lazily load the real expo-notifications module. Kept behind a dynamic import
 * so importing THIS file (e.g. from a test or a non-notification code path)
 * doesn't pull in the native module. Never called by the unit tests, which
 * inject a fake provider instead.
 */
async function loadNotifications(): Promise<NotificationsProvider> {
  // expo-notifications ships its own types at runtime; the dynamic import keeps
  // it out of the module graph for non-push code + tests. The cast below adapts
  // the module to our narrow NotificationsProvider interface.
  const mod = await import("expo-notifications");
  return mod as unknown as NotificationsProvider;
}

/**
 * POST the token to the box push endpoint. Behind `registerPushToken`; a no-op
 * (returns false-as-"not posted" without touching the network) when the backend
 * is unconfigured. Returns true on a 2xx POST. Any transport error resolves to
 * false so the caller classifies it as an error rather than throwing.
 *
 * This is THE interface the issue asks for: `registerPushToken(token)` is
 * stub/no-op when no push backend is configured.
 */
export async function registerPushToken(
  token: string,
  opts: {
    boxId: string;
    platform: PushPlatform;
    config?: PushConfig;
    fetchFn?: typeof fetch;
  },
): Promise<boolean> {
  const config = opts.config ?? DEFAULT_PUSH_CONFIG;
  // No-op path — the M5 dependency. Nothing is sent; the flow is still proven.
  if (!isPushBackendConfigured(config)) return false;

  const doFetch = opts.fetchFn ?? fetch;
  const body = buildRegisterBody({ token, boxId: opts.boxId, platform: opts.platform });
  try {
    const res = await doFetch(config.endpoint as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run the full registration flow and return the classified terminal result:
 *   1. read (and if needed request) notification permission;
 *   2. if granted, obtain the Expo push token;
 *   3. hand the token to `registerPushToken` (POST or no-op);
 *   4. classify the outcome via the pure classifier.
 *
 * Never throws — every failure maps to `{ kind: "error" }` — so a caller can
 * render the result inline. Runs end-to-end on the simulator with the default
 * unconfigured backend, resolving to `{ kind: "unconfigured", token }`.
 */
export async function registerForPushNotifications(
  opts: RegisterPushOptions,
): Promise<PushRegistrationResult> {
  const config = opts.config ?? DEFAULT_PUSH_CONFIG;
  let notifications: NotificationsProvider;
  try {
    notifications = opts.notifications ?? (await loadNotifications());
  } catch {
    return { kind: "error", message: "Notifications are unavailable on this device." };
  }

  // 1. Permission: read current, request if not already decided.
  let status: PushPermissionStatus;
  try {
    const existing = await notifications.getPermissionsAsync();
    status = normalizeStatus(existing.status);
    if (status !== "granted") {
      const requested = await notifications.requestPermissionsAsync();
      status = normalizeStatus(requested.status);
    }
  } catch {
    return { kind: "error", message: "Could not read notification permission." };
  }

  if (!shouldRegister(status)) {
    return classifyRegistration({
      status,
      token: null,
      backendConfigured: isPushBackendConfigured(config),
      posted: false,
    });
  }

  // 2. Obtain the Expo push token.
  let token: string | null = null;
  try {
    const res = await notifications.getExpoPushTokenAsync();
    token = typeof res?.data === "string" && res.data.length > 0 ? res.data : null;
  } catch {
    token = null;
  }
  if (!token) {
    return classifyRegistration({
      status,
      token: null,
      backendConfigured: isPushBackendConfigured(config),
      posted: false,
    });
  }

  // 3. Register (POST or no-op) + 4. classify.
  const backendConfigured = isPushBackendConfigured(config);
  const posted = await registerPushToken(token, {
    boxId: opts.boxId,
    platform: opts.platform,
    config,
    fetchFn: opts.fetchFn,
  });
  return classifyRegistration({ status, token, backendConfigured, posted });
}
