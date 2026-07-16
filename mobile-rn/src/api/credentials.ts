// credentials.ts — persist { serverUrl, boxId, boxToken } in the device keychain
// via expo-secure-store. This is the RN equivalent of the web client's
// localStorage["manta_server"] / localStorage["manta_token"] pair — but backed by
// the iOS Keychain / Android Keystore so the box_token is stored at rest
// encrypted, not in plaintext.
//
// The pure claim/parse logic lives in ../pure/claim.ts; this module owns only
// the Keychain read/write side effects and is intentionally thin.

import * as SecureStore from "expo-secure-store";

const KEY_SERVER = "manta_server";
const KEY_BOX_ID = "manta_box_id";
const KEY_BOX_TOKEN = "manta_box_token";

export interface StoredCredentials {
  serverUrl: string;
  boxId: string;
  boxToken: string;
}

/**
 * Persist the paired credentials. Called after a successful /auth/claim. Writes
 * three keys so each can be read independently; SecureStore serializes each to
 * the platform keychain.
 */
export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_SERVER, creds.serverUrl),
    SecureStore.setItemAsync(KEY_BOX_ID, creds.boxId),
    SecureStore.setItemAsync(KEY_BOX_TOKEN, creds.boxToken),
  ]);
}

/**
 * Load the paired credentials, or null when unpaired (any key missing). Used on
 * app launch to decide whether to show the pairing screen or jump straight to
 * the session list.
 */
export async function loadCredentials(): Promise<StoredCredentials | null> {
  const [serverUrl, boxId, boxToken] = await Promise.all([
    SecureStore.getItemAsync(KEY_SERVER),
    SecureStore.getItemAsync(KEY_BOX_ID),
    SecureStore.getItemAsync(KEY_BOX_TOKEN),
  ]);
  if (!serverUrl || !boxId || !boxToken) return null;
  return { serverUrl, boxId, boxToken };
}

/** Clear all paired credentials (re-pair path). */
export async function clearCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_SERVER),
    SecureStore.deleteItemAsync(KEY_BOX_ID),
    SecureStore.deleteItemAsync(KEY_BOX_TOKEN),
  ]);
}
