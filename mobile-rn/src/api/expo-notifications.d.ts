// Ambient declaration for the optional `expo-notifications` native module.
//
// The push scaffold (src/api/push.ts) lazily `import("expo-notifications")` so
// the native module stays out of the module graph for non-push code and the
// unit tests (which inject a fake NotificationsProvider). expo-notifications is
// a native module that isn't resolvable in the pure typecheck/test environment,
// so we declare the narrow surface the scaffold touches here. This lets the
// dynamic import type-check WITHOUT an `@ts-expect-error` suppression and
// WITHOUT requiring the native package to be installed for `tsc --noEmit`.
//
// At runtime on the device / Expo Go, the real expo-notifications module is
// present and provides these (and many more) APIs; the cast in push.ts adapts
// it to our NotificationsProvider interface.
declare module "expo-notifications" {
  export function getPermissionsAsync(): Promise<{ status: string }>;
  export function requestPermissionsAsync(): Promise<{ status: string }>;
  export function getExpoPushTokenAsync(): Promise<{ data: string }>;
}
