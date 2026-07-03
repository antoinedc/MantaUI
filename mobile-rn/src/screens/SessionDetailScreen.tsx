// SessionDetailScreen.tsx — the read-only live transcript view (M3.5-1 bar).
//
// Pushed from a SessionListScreen chat-row tap. On mount it fetches the
// session's transcript from the box's `opencode:messages` channel and opens the
// `/events` WebSocket (filtered to this session) for live updates: streamed
// text deltas append to the running assistant message; session.idle/status
// flips the running indicator. Renders a FlatList of message rows (user /
// assistant text / tool-call summaries) with pin-to-bottom and pull-to-refresh.
//
// READ-ONLY in this slice — no composer / prompt sending (that's stage 2). All
// transcript/event LOGIC lives in the pure ../pure/transcript + ../pure/events
// modules; this component owns fetch + socket + render.

import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import { AuthRequiredError, fetchTranscript } from "../api/pairingApi";
import { clearCredentials } from "../api/credentials";
import { subscribeOpencodeEvents } from "../api/eventsClient";
import {
  applyOpencodeEvent,
  type MessageRowVM,
  type TranscriptVM,
} from "../pure/transcript";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Session">;

const EMPTY: TranscriptVM = { rows: [], running: false };

export function SessionDetailScreen({ navigation, route }: Props) {
  const { credentials, session } = route.params;
  const sessionId = session.opencodeSessionId ?? "";

  const [vm, setVm] = useState<TranscriptVM>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<FlatList<MessageRowVM>>(null);
  // Pin-to-bottom latch: only auto-scroll when the user is already near the
  // bottom, so scrolling up to read history isn't yanked back on each event.
  const atBottomRef = useRef(true);

  // Set the header to the session title.
  useEffect(() => {
    navigation.setOptions({ title: session.title });
  }, [navigation, session.title]);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!sessionId) {
        setError("This window has no chat session to display.");
        setLoading(false);
        return;
      }
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const next = await fetchTranscript(
          credentials.serverUrl,
          credentials.boxToken,
          sessionId,
        );
        setVm(next);
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setError(
          e instanceof Error ? e.message : "Couldn't load the transcript. Pull to retry.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [credentials.serverUrl, credentials.boxToken, sessionId, navigation],
  );

  // Initial fetch.
  useEffect(() => {
    void load("initial");
  }, [load]);

  // Live event subscription — filtered to this session by the events client.
  useEffect(() => {
    if (!sessionId) return;
    const sub = subscribeOpencodeEvents(
      credentials.serverUrl,
      credentials.boxToken,
      sessionId,
      (ev) => {
        // Cheap live edits (delta append, running flag) apply in place. Other
        // events (new parts, tool state, message.updated) are covered by the
        // canonical text the next delta/refresh carries; a full re-fetch on
        // every event would thrash the list, so we keep it lean here.
        setVm((prev) => applyOpencodeEvent(prev, ev));
      },
    );
    return () => sub.close();
  }, [credentials.serverUrl, credentials.boxToken, sessionId]);

  // Pin-to-bottom: after rows change, if the user was at the bottom, scroll
  // to the newest content.
  useEffect(() => {
    if (atBottomRef.current && vm.rows.length > 0) {
      // Defer so the list has laid out the new content first.
      const t = setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [vm.rows]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {vm.running && (
        <View style={styles.runningBar}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.runningText}>Working…</Text>
        </View>
      )}
      <FlatList
        ref={listRef}
        data={vm.rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={vm.rows.length === 0 ? styles.emptyContainer : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load("refresh")}
            tintColor={colors.textMuted}
          />
        }
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distanceFromBottom =
            contentSize.height - (contentOffset.y + layoutMeasurement.height);
          atBottomRef.current = distanceFromBottom < 80;
        }}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {error ?? "No messages yet. Pull to refresh."}
          </Text>
        }
        renderItem={({ item }) => <MessageRow row={item} />}
      />
      {error && vm.rows.length > 0 && <Text style={styles.errorBar}>{error}</Text>}
    </View>
  );
}

function MessageRow({ row }: { row: MessageRowVM }) {
  const isUser = row.role === "user";
  return (
    <View style={[styles.msg, isUser ? styles.msgUser : styles.msgAssistant]}>
      <Text style={styles.roleLabel}>
        {isUser ? "You" : "Assistant"}
        {row.model ? ` · ${row.model}` : ""}
      </Text>
      {row.text.length > 0 && <Text style={styles.msgText}>{row.text}</Text>}
      {row.tools.map((t) => (
        <View key={t.key} style={styles.tool}>
          <Text style={styles.toolText} numberOfLines={1}>
            {toolGlyph(t.status)} {t.name}
            {t.title ? ` · ${t.title}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function toolGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✗";
  if (status === "running") return "…";
  return "•";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  list: { padding: 12, gap: 8 },
  emptyContainer: { flexGrow: 1, justifyContent: "center" },
  empty: {
    color: colors.textFaint,
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  runningBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  runningText: { color: colors.textMuted, fontSize: 13 },
  msg: {
    borderRadius: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  msgUser: { backgroundColor: colors.surface },
  msgAssistant: { backgroundColor: "transparent" },
  roleLabel: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  msgText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  tool: {
    marginTop: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  toolText: { color: colors.textMuted, fontSize: 13, fontFamily: "monospace" },
  errorBar: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 8,
  },
});
