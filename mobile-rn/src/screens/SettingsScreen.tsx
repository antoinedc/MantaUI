// SettingsScreen.tsx — the paired-device settings screen (M3.5-3).
//
// Pushed from the Sessions header gear. Shows:
//   • Connection: the paired server URL + boxId (READ-ONLY — they come from
//     pairing and can't be edited here), and a "Re-pair / disconnect" action
//     that clears the keychain credentials and returns to the Pairing screen.
//   • Default model: the connected-provider model list (opencode:models) with a
//     checkmark on the current default (opencode:default-model); tapping a row
//     persists it via config:update({ defaultModel }) — the same write the
//     desktop uses.
//   • Notifications: a button that runs the push-registration scaffold
//     (permission → Expo token → registerPushToken). With no push backend
//     configured (the default until M5), it resolves to "unconfigured" — the
//     token is obtained but not sent. Proven here with zero Apple credentials.
//
// All raw-JSON → view-model + decision LOGIC lives in the pure ../pure/*
// modules (modelPicker, push); this component owns fetch + render + navigation.

import { useCallback, useEffect, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import {
  AuthRequiredError,
  fetchModelGroups,
  setDefaultModel,
} from "../api/pairingApi";
import { clearCredentials } from "../api/credentials";
import { registerForPushNotifications } from "../api/push";
import {
  countModels,
  type DefaultModel,
  type ModelRowVM,
  type ProviderGroupVM,
} from "../pure/modelPicker";
import type { PushRegistrationResult } from "../pure/push";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

function pushPlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function pushResultMessage(r: PushRegistrationResult): string {
  switch (r.kind) {
    case "permission-denied":
      return "Notifications are off. Enable them in Settings to get push alerts.";
    case "unconfigured":
      return "Ready. Push delivery turns on in a future update (token obtained).";
    case "registered":
      return "Registered for push notifications.";
    case "error":
      return r.message;
  }
}

export function SettingsScreen({ navigation, route }: Props) {
  const { credentials } = route.params;

  const [groups, setGroups] = useState<ProviderGroupVM[]>([]);
  const [current, setCurrent] = useState<DefaultModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [pushBusy, setPushBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setModelError(null);
    try {
      const { groups: g, current: c } = await fetchModelGroups(
        credentials.serverUrl,
        credentials.boxToken,
      );
      setGroups(g);
      setCurrent(c);
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        await clearCredentials();
        navigation.replace("Pairing");
        return;
      }
      setModelError(
        e instanceof Error ? e.message : "Couldn't load models. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [credentials.serverUrl, credentials.boxToken, navigation]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const onPickModel = useCallback(
    async (row: ModelRowVM) => {
      if (savingKey) return;
      setSavingKey(row.key);
      setModelError(null);
      try {
        const saved = await setDefaultModel(
          credentials.serverUrl,
          credentials.boxToken,
          { providerID: row.providerID, modelID: row.modelID },
        );
        const next = saved ?? { providerID: row.providerID, modelID: row.modelID };
        setCurrent(next);
        // Re-mark selected rows from the confirmed default.
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            rows: g.rows.map((r) => ({
              ...r,
              selected: r.providerID === next.providerID && r.modelID === next.modelID,
            })),
          })),
        );
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setModelError(
          e instanceof Error ? e.message : "Couldn't set the default model.",
        );
      } finally {
        setSavingKey(null);
      }
    },
    [credentials.serverUrl, credentials.boxToken, navigation, savingKey],
  );

  const onRepair = useCallback(() => {
    Alert.alert(
      "Disconnect this box?",
      "You'll need to re-pair with a new code to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await clearCredentials();
              navigation.replace("Pairing");
            })();
          },
        },
      ],
    );
  }, [navigation]);

  const onEnablePush = useCallback(async () => {
    setPushBusy(true);
    setPushStatus(null);
    try {
      const result = await registerForPushNotifications({
        boxId: credentials.boxId,
        platform: pushPlatform(),
      });
      setPushStatus(pushResultMessage(result));
    } finally {
      setPushBusy(false);
    }
  }, [credentials.boxId]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Connection */}
      <Text style={styles.sectionTitle}>Connection</Text>
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Server URL</Text>
        <Text style={styles.fieldValue} numberOfLines={1} selectable>
          {credentials.serverUrl}
        </Text>
        <View style={styles.fieldDivider} />
        <Text style={styles.fieldLabel}>Box ID</Text>
        <Text style={styles.fieldValue} numberOfLines={1} selectable>
          {credentials.boxId}
        </Text>
      </View>
      <Pressable
        style={styles.dangerBtn}
        onPress={onRepair}
        accessibilityRole="button"
        accessibilityLabel="Re-pair or disconnect"
      >
        <Text style={styles.dangerBtnText}>Re-pair / disconnect</Text>
      </Pressable>

      {/* Default model */}
      <Text style={styles.sectionTitle}>Default model</Text>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : modelError ? (
        <View style={styles.card}>
          <Text style={styles.errorText}>{modelError}</Text>
          <Pressable style={styles.secondaryBtn} onPress={() => void loadModels()}>
            <Text style={styles.secondaryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : countModels(groups) === 0 ? (
        <View style={styles.card}>
          <Text style={styles.muted}>
            No connected providers. Add one from the desktop app, then reload.
          </Text>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.providerID} style={styles.card}>
            <Text style={styles.providerLabel}>{g.providerID}</Text>
            {g.rows.map((row) => (
              <Pressable
                key={row.key}
                style={styles.modelRow}
                onPress={() => void onPickModel(row)}
                disabled={savingKey !== null}
                accessibilityRole="button"
                accessibilityState={{ selected: row.selected }}
                accessibilityLabel={`${g.providerID} ${row.label}${row.selected ? ", selected" : ""}`}
              >
                <Text
                  style={[styles.modelName, row.selected && styles.modelNameSelected]}
                  numberOfLines={1}
                >
                  {row.label}
                </Text>
                {savingKey === row.key ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : row.selected ? (
                  <Text style={styles.check}>✓</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ))
      )}
      {current && (
        <Text style={styles.currentHint}>
          Current: {current.providerID} / {current.modelID}
        </Text>
      )}

      {/* Notifications */}
      <Text style={styles.sectionTitle}>Notifications</Text>
      <View style={styles.card}>
        <Text style={styles.muted}>
          Get notified when a session finishes or asks for input.
        </Text>
        <Pressable
          style={[styles.secondaryBtn, pushBusy && styles.btnDisabled]}
          onPress={() => void onEnablePush()}
          disabled={pushBusy}
          accessibilityRole="button"
          accessibilityLabel="Enable notifications"
        >
          {pushBusy ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.secondaryBtnText}>Enable notifications</Text>
          )}
        </Pressable>
        {pushStatus && <Text style={styles.pushStatus}>{pushStatus}</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 8, paddingBottom: 40 },
  center: { paddingVertical: 24, alignItems: "center" },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 4,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  fieldLabel: { color: colors.textMuted, fontSize: 12 },
  fieldValue: { color: colors.text, fontSize: 15, fontFamily: "monospace" },
  fieldDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 4,
  },
  providerLabel: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  modelName: { color: colors.text, fontSize: 15, flex: 1, minWidth: 0 },
  modelNameSelected: { color: colors.accent, fontWeight: "600" },
  check: { color: colors.accent, fontSize: 18, fontWeight: "700" },
  currentHint: { color: colors.textFaint, fontSize: 12, marginTop: 4 },
  muted: { color: colors.textMuted, fontSize: 14 },
  errorText: { color: colors.danger, fontSize: 14 },
  dangerBtn: {
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  dangerBtnText: { color: colors.danger, fontSize: 15, fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  pushStatus: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
});
