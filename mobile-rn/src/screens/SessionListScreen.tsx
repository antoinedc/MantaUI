// SessionListScreen.tsx — the read-only post-pairing screen (M3.2 bar).
//
// Calls the box's `tmux:list` rpc channel (Bearer box_token) and renders a
// read-only FlatList of sessions: title + running/idle dot, grouped by project.
// Tapping a row shows a "opens on a later milestone" placeholder — NO transcript
// streaming, NO prompt sending (that's M5). The raw-JSON → row mapping is the
// pure ../pure/sessionList module; this component owns fetch + render.

import { useCallback, useEffect, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import { AuthRequiredError, fetchSessionList } from "../api/pairingApi";
import { clearCredentials } from "../api/credentials";
import type { SessionRowVM } from "../pure/sessionList";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Sessions">;

export function SessionListScreen({ navigation, route }: Props) {
  const { credentials } = route.params;
  const [rows, setRows] = useState<SessionRowVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const list = await fetchSessionList(
          credentials.serverUrl,
          credentials.boxToken,
        );
        setRows(list);
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          // Token no longer valid — drop credentials and return to pairing.
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setError(
          e instanceof Error ? e.message : "Couldn't load sessions. Pull to retry.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [credentials.serverUrl, credentials.boxToken, navigation],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  function onRowPress(row: SessionRowVM) {
    // M3.2 is read-only: opening a live session (streaming transcript) lands in
    // a later milestone. Surface that clearly instead of a dead tap.
    Alert.alert(
      row.title,
      "Live sessions open in a future update. This preview shows your sessions read-only.",
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load("refresh")}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {error ?? "No sessions yet. Create one from the desktop app, then pull to refresh."}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => onRowPress(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.project} / ${item.title}, ${item.status}`}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: item.status === "running" ? colors.running : colors.idle },
              ]}
            />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.project} · {item.kind}
                {item.status === "running" ? " · running" : ""}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
      {error && rows.length > 0 && (
        <Text style={styles.errorBar}>{error}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  emptyContainer: { flexGrow: 1, justifyContent: "center" },
  empty: {
    color: colors.textFaint,
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  chevron: { color: colors.textFaint, fontSize: 22 },
  errorBar: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 8,
  },
});
