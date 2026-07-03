// push.ts (pure) — the decision logic for the push-registration scaffold.
//
// The mobile push story is split into three tiers by the M-plan:
//   • THIS slice (M3.5-3, BET-78): build + unit-test the registration FLOW —
//     ask permission, obtain the Expo push token, POST it to a box endpoint —
//     but behind an interface that is a NO-OP when no push backend is
//     configured, so it compiles + runs on the simulator/Expo Go with ZERO
//     Apple credentials.
//   • M5 (human-blocked): wire LIVE native APNs delivery once the operator
//     provides the APNs .p8 signing key. Only the delivery leg waits — the
//     registration flow proven here does not change.
//
// This module owns the framework-free DECISIONS so the impure ../api/push.ts
// wrapper (which touches expo-notifications + fetch) stays thin and the flow is
// fully unit-testable without a live APNs backend or a device. Mirrors the
// pure↔impure split of the rest of mobile-rn.

/** Permission outcomes we care about, normalized from expo-notifications. */
export type PushPermissionStatus = "granted" | "denied" | "undetermined";

/** The terminal result of a registration attempt, for the caller to render. */
export type PushRegistrationResult =
  /** Permission was refused — nothing sent; UI shows "notifications off". */
  | { kind: "permission-denied" }
  /** Permission granted but no push backend is configured — token obtained,
   *  registration was a no-op (the M5 dependency). */
  | { kind: "unconfigured"; token: string }
  /** Permission granted and the token was POSTed to the box endpoint. */
  | { kind: "registered"; token: string }
  /** Something failed obtaining the token or posting it. */
  | { kind: "error"; message: string };

/**
 * Whether we should proceed to obtain a push token given a permission status.
 * Only "granted" proceeds; "denied"/"undetermined" stop (the caller may have
 * already requested, so undetermined here means the OS still didn't grant).
 * Pure.
 */
export function shouldRegister(status: PushPermissionStatus): boolean {
  return status === "granted";
}

/**
 * Whether a push backend is configured — i.e. whether `registerPushToken` will
 * actually POST or short-circuit as a no-op. A backend is "configured" only
 * when a non-empty endpoint URL is present. Until M5 wires the operator's push
 * service, this is intentionally false in the default build, so the whole flow
 * degrades to `{ kind: "unconfigured" }`. Pure.
 */
export function isPushBackendConfigured(
  config: { endpoint?: string | null } | null | undefined,
): boolean {
  return !!config && typeof config.endpoint === "string" && config.endpoint.trim().length > 0;
}

/**
 * Classify a completed registration flow into the terminal result, given:
 *  - the (already-resolved) permission status,
 *  - the token obtained (null if none / permission denied),
 *  - whether a backend was configured,
 *  - whether the POST (if attempted) succeeded.
 *
 * This is the single source of truth for "what did registration do", so the
 * impure wrapper just feeds it facts. Pure.
 */
export function classifyRegistration(input: {
  status: PushPermissionStatus;
  token: string | null;
  backendConfigured: boolean;
  posted: boolean;
}): PushRegistrationResult {
  if (input.status !== "granted") return { kind: "permission-denied" };
  if (!input.token) {
    return { kind: "error", message: "Could not obtain a push token." };
  }
  if (!input.backendConfigured) {
    return { kind: "unconfigured", token: input.token };
  }
  return input.posted
    ? { kind: "registered", token: input.token }
    : { kind: "error", message: "Failed to register the push token with the box." };
}

/**
 * Build the JSON body POSTed to the box's push-registration endpoint. Kept pure
 * so the wire shape is pinned by a test. The box binds `{ token, boxId,
 * platform }` to the box_id for later APNs/FCM delivery (M5). Pure.
 */
export function buildRegisterBody(input: {
  token: string;
  boxId: string;
  platform: "ios" | "android" | "web";
}): { token: string; boxId: string; platform: string } {
  return { token: input.token, boxId: input.boxId, platform: input.platform };
}
