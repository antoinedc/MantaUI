// PairingScreen.tsx — QR-scan + manual-entry pairing.
//
// Two paths to the same outcome (server URL + 6-digit code → claim token):
//   • Scan: tap "Scan QR code" → expo-camera CameraView decodes a
//     bui://pair?server=…&code=… QR → decideScan → claim → Sessions.
//   • Manual: type the server URL + 6-digit code (the fallback for Expo Go on a
//     simulator, which has no camera). Always available.
//
// All branch/validation LOGIC is pure (../pure/*). This component owns the RN
// widgets, the camera permission dance, and the async claim call.

import { useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import type { RootStackParamList } from "../../App";
import { claimPairingCode } from "../api/pairingApi";
import {
  isSubmittableCode,
  normalizeCode,
  type ClaimResult,
} from "../pure/claim";
import { isValidServerUrl, normalizeServerUrl } from "../pure/pairPayload";
import {
  classifyCameraAvailability,
  decideScan,
} from "../pure/scanWiring";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Pairing">;

export function PairingScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availability = classifyCameraAvailability(permission);

  // Perform the claim + navigate on success; render the classified failure
  // inline otherwise. Shared by the scan and manual paths.
  async function pair(url: string, pairingCode: string) {
    setBusy(true);
    setError(null);
    let result: ClaimResult;
    try {
      result = await claimPairingCode(url, pairingCode);
    } catch {
      setBusy(false);
      setError("Something went wrong. Try again.");
      return;
    }
    setBusy(false);
    if (result.ok) {
      navigation.replace("Sessions", {
        credentials: {
          serverUrl: normalizeServerUrl(url),
          boxId: result.boxId,
          boxToken: result.boxToken,
        },
      });
      return;
    }
    setError(result.message);
  }

  async function onScanPress() {
    setError(null);
    if (availability === "unavailable") {
      setError("No camera available. Enter the code manually below.");
      return;
    }
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError("Camera permission is needed to scan. Enter the code manually below.");
        return;
      }
    }
    setScanning(true);
  }

  function onBarcodeScanned(raw: string) {
    if (!scanning) return;
    setScanning(false);
    const decision = decideScan(raw);
    if (decision.kind === "invalid") {
      setError(decision.message);
      return;
    }
    void pair(decision.payload.serverUrl, decision.payload.code);
  }

  const manualCanSubmit =
    !busy && isValidServerUrl(serverUrl) && isSubmittableCode(code);

  if (scanning) {
    return (
      <View style={styles.scannerFill}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(e) => onBarcodeScanned(e.data)}
        />
        <View style={styles.scannerOverlay}>
          <Text style={styles.scannerHint}>
            Point at the QR code on your desktop
          </Text>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => setScanning(false)}
          >
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Connect to your box</Text>
      <Text style={styles.subtle}>
        Scan the pairing QR shown by the desktop app, or enter the details
        manually.
      </Text>

      <Pressable
        style={[styles.primaryBtn, busy && styles.btnDisabled]}
        onPress={onScanPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Scan QR code"
      >
        <Text style={styles.primaryBtnText}>Scan QR code</Text>
      </Pressable>

      {availability === "unavailable" && (
        <Text style={styles.hint}>
          No camera on this device — use manual entry below.
        </Text>
      )}
      {availability === "denied" && (
        <Text style={styles.hint}>
          Camera access is off. Enable it in Settings, or enter the code below.
        </Text>
      )}

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or enter manually</Text>
        <View style={styles.dividerLine} />
      </View>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        placeholder="http://192.168.1.10:8787"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={serverUrl}
        editable={!busy}
        onChangeText={setServerUrl}
      />

      <Text style={styles.label}>Pairing code</Text>
      <TextInput
        style={styles.input}
        placeholder="6-digit code"
        placeholderTextColor={colors.textFaint}
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        editable={!busy}
        onChangeText={(t) => setCode(normalizeCode(t))}
      />

      <Pressable
        style={[styles.primaryBtn, !manualCanSubmit && styles.btnDisabled]}
        onPress={() => void pair(serverUrl, code)}
        disabled={!manualCanSubmit}
        accessibilityRole="button"
        accessibilityLabel="Connect"
      >
        {busy ? (
          <ActivityIndicator color={colors.accentText} />
        ) : (
          <Text style={styles.primaryBtnText}>Connect</Text>
        )}
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 22, fontWeight: "700" },
  subtle: { color: colors.textMuted, fontSize: 14, marginBottom: 8 },
  label: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  primaryBtnText: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  btnDisabled: { opacity: 0.4 },
  hint: { color: colors.textFaint, fontSize: 13 },
  error: { color: colors.danger, fontSize: 14, marginTop: 8 },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textFaint, fontSize: 12 },
  scannerFill: { flex: 1, backgroundColor: "#000" },
  scannerOverlay: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 16,
  },
  scannerHint: {
    color: "#fff",
    fontSize: 15,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
});
