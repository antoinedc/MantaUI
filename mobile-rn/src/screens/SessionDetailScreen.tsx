// SessionDetailScreen.tsx — the live transcript + interactive session view.
//
// Pushed from a SessionListScreen chat-row tap. On mount it fetches the
// session's transcript from the box's `opencode:messages` channel and opens the
// `/events` WebSocket (filtered to this session) for live updates: streamed
// text deltas append to the running assistant message; session.idle/status
// flips the running indicator. Renders a FlatList of message rows (user /
// assistant text / tool-call summaries) with pin-to-bottom and pull-to-refresh.
//
// M3.5-2 adds interactivity: a Composer to send prompts (opencode:prompt) with
// an optimistic user row + abort, and Permission/Question cards driven by the
// same /events subscription (permission.asked / question.asked) so a turn that
// blocks on the box can be answered from the phone. All decision LOGIC lives in
// the pure ../pure/{transcript,events,composer,interaction} modules; this
// component owns fetch + socket + render.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import {
  AuthRequiredError,
  abortSession,
  dispatchSessionAction,
  fetchPermissions,
  fetchQuestions,
  fetchTranscript,
  rejectQuestion,
  replyPermission,
  replyQuestion,
  sendPrompt,
} from "../api/pairingApi";
import {
  availableActions,
  resolveSessionAction,
  type SessionActionKind,
} from "../pure/sessionActions";
import { clearCredentials } from "../api/credentials";
import { subscribeOpencodeEvents } from "../api/eventsClient";
import {
  applyOpencodeEvent,
  type MessageRowVM,
  type TranscriptVM,
} from "../pure/transcript";
import {
  applyPermissionEvent,
  applyQuestionEvent,
  type PermissionReply,
  type PermissionVM,
  type QuestionVM,
} from "../pure/interaction";
import { Composer } from "./Composer";
import { PermissionCard } from "./cards/PermissionCard";
import { QuestionCard } from "./cards/QuestionCard";
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
  // Pending interaction cards, driven by the /events subscription + a mount
  // hydrate (an ask fired before we attached is recoverable via the list RPC).
  const [permissions, setPermissions] = useState<PermissionVM[]>([]);
  const [questions, setQuestions] = useState<QuestionVM[]>([]);
  // A card whose reply is in flight — disables its buttons to prevent a
  // double-submit while the round-trip is outstanding.
  const [busyCardId, setBusyCardId] = useState<string | null>(null);

  const listRef = useRef<FlatList<MessageRowVM>>(null);
  // Pin-to-bottom latch: only auto-scroll when the user is already near the
  // bottom, so scrolling up to read history isn't yanked back on each event.
  const atBottomRef = useRef(true);

  // A session action (new/fork/compact) in flight — disables the header menu.
  const [actionBusy, setActionBusy] = useState(false);

  // Run a session action: resolve the channel+payload with the pure module,
  // dispatch it, and surface the outcome. "new" resets the conversation on this
  // window; "fork" spawns a new window on the box; "compact" summarizes context
  // in place. All are best-effort — a failure alerts rather than crashing.
  const runAction = useCallback(
    async (kind: SessionActionKind) => {
      const request = resolveSessionAction(kind, session);
      if (!request) return;
      setActionBusy(true);
      try {
        await dispatchSessionAction(
          credentials.serverUrl,
          credentials.boxToken,
          request,
        );
        if (kind === "new") {
          // The window now holds a fresh session id; the transcript we're
          // showing is stale. Reload it (the box re-stamped the same window).
          void load("refresh");
        } else if (kind === "fork") {
          Alert.alert("Forked", "A new window was created on your box.");
        } else if (kind === "compact") {
          Alert.alert("Compacting", "The session context is being summarized.");
        }
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        Alert.alert("Couldn't complete that", e instanceof Error ? e.message : "Try again.");
      } finally {
        setActionBusy(false);
      }
    },
    [credentials.serverUrl, credentials.boxToken, session, navigation],
  );

  const onMenuPress = useCallback(() => {
    const actions = availableActions(session);
    if (actions.length === 0) return;
    const label: Record<SessionActionKind, string> = {
      new: "New chat (clear)",
      clear: "Clear",
      fork: "Fork to new window",
      compact: "Compact context",
    };
    Alert.alert("Session actions", session.title, [
      ...actions.map((a) => ({
        text: label[a],
        onPress: () => void runAction(a),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }, [session, runAction]);

  // Set the header title + the actions menu button.
  useLayoutEffect(() => {
    navigation.setOptions({
      title: session.title,
      headerRight:
        availableActions(session).length > 0
          ? () => (
              <Pressable
                onPress={onMenuPress}
                disabled={actionBusy}
                accessibilityRole="button"
                accessibilityLabel="Session actions"
                hitSlop={12}
              >
                <Text style={[styles.headerMenu, actionBusy && styles.headerMenuBusy]}>⋯</Text>
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, session, onMenuPress, actionBusy]);

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
        // Recover any interaction cards that fired before we attached. These
        // are best-effort — a failure here must not blank the transcript, so
        // they're swallowed (the live event stream is the primary path).
        void hydrateCards();
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

  // Best-effort hydrate of pending permission/question cards on (re)attach.
  // Never throws — a live ask that arrived before mount is recovered here; the
  // live event stream keeps them fresh afterward.
  const hydrateCards = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [perms, qs] = await Promise.all([
        fetchPermissions(credentials.serverUrl, credentials.boxToken, sessionId),
        fetchQuestions(credentials.serverUrl, credentials.boxToken, sessionId),
      ]);
      setPermissions(perms);
      setQuestions(qs);
    } catch {
      /* card hydrate is non-fatal — the /events stream is the primary path */
    }
  }, [credentials.serverUrl, credentials.boxToken, sessionId]);

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
        // Cheap transcript edits (delta append, running flag) apply in place.
        setVm((prev) => applyOpencodeEvent(prev, ev));
        // Interaction cards appear/clear live off the same stream.
        const props = ev.properties ?? undefined;
        if (ev.type.startsWith("permission.")) {
          setPermissions((prev) =>
            applyPermissionEvent(prev, ev.type, props, sessionId),
          );
        } else if (ev.type.startsWith("question.")) {
          setQuestions((prev) =>
            applyQuestionEvent(prev, ev.type, props, sessionId),
          );
        }
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

  // ---- Interaction handlers ----

  // Send a prompt. Optimistically append a user row + flip running so the UI
  // reacts instantly; the canonical rows arrive over the event stream. On a
  // send failure we surface an error and clear the optimistic running flag (the
  // optimistic user row is left — it matches what the user typed).
  const handleSend = useCallback(
    async (text: string) => {
      atBottomRef.current = true;
      setVm((prev) => ({
        rows: [
          ...prev.rows,
          {
            key: `optimistic-${Date.now()}`,
            role: "user",
            text,
            tools: [],
            createdAt: Date.now(),
          },
        ],
        running: true,
      }));
      try {
        await sendPrompt(credentials.serverUrl, credentials.boxToken, sessionId, text);
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setVm((prev) => ({ ...prev, running: false }));
        setError(e instanceof Error ? e.message : "Couldn't send. Try again.");
      }
    },
    [credentials.serverUrl, credentials.boxToken, sessionId, navigation],
  );

  const handleAbort = useCallback(async () => {
    try {
      await abortSession(credentials.serverUrl, credentials.boxToken, sessionId);
      setVm((prev) => ({ ...prev, running: false }));
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        await clearCredentials();
        navigation.replace("Pairing");
      }
      /* other abort errors are benign — the idle event will settle running */
    }
  }, [credentials.serverUrl, credentials.boxToken, sessionId, navigation]);

  const handlePermissionReply = useCallback(
    async (perm: PermissionVM, reply: PermissionReply) => {
      setBusyCardId(perm.id);
      try {
        await replyPermission(
          credentials.serverUrl,
          credentials.boxToken,
          perm.requestId,
          reply,
          sessionId,
        );
        // Optimistically clear; the permission.replied event also clears it.
        setPermissions((prev) => prev.filter((p) => p.id !== perm.id));
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setError(e instanceof Error ? e.message : "Couldn't send the reply.");
      } finally {
        setBusyCardId(null);
      }
    },
    [credentials.serverUrl, credentials.boxToken, sessionId, navigation],
  );

  const handleQuestionReply = useCallback(
    async (q: QuestionVM, answers: string[][]) => {
      setBusyCardId(q.id);
      try {
        await replyQuestion(
          credentials.serverUrl,
          credentials.boxToken,
          q.requestId,
          answers,
          sessionId,
        );
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setError(e instanceof Error ? e.message : "Couldn't send the answer.");
      } finally {
        setBusyCardId(null);
      }
    },
    [credentials.serverUrl, credentials.boxToken, sessionId, navigation],
  );

  const handleQuestionReject = useCallback(
    async (q: QuestionVM) => {
      setBusyCardId(q.id);
      try {
        await rejectQuestion(
          credentials.serverUrl,
          credentials.boxToken,
          q.requestId,
          sessionId,
        );
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          await clearCredentials();
          navigation.replace("Pairing");
          return;
        }
        setError(e instanceof Error ? e.message : "Couldn't dismiss the question.");
      } finally {
        setBusyCardId(null);
      }
    },
    [credentials.serverUrl, credentials.boxToken, sessionId, navigation],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
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

      {/* Interaction cards stack above the composer: permissions first (they
          block the turn hardest), then questions. */}
      {permissions.map((perm) => (
        <PermissionCard
          key={perm.id}
          perm={perm}
          busy={busyCardId === perm.id}
          onReply={(reply) => void handlePermissionReply(perm, reply)}
        />
      ))}
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          request={q}
          busy={busyCardId === q.id}
          onReply={(answers) => void handleQuestionReply(q, answers)}
          onReject={() => void handleQuestionReject(q)}
        />
      ))}

      {sessionId ? (
        <Composer
          running={vm.running}
          onSend={(text) => void handleSend(text)}
          onAbort={() => void handleAbort()}
        />
      ) : null}
    </KeyboardAvoidingView>
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
  headerMenu: { color: colors.text, fontSize: 24, fontWeight: "700" },
  headerMenuBusy: { opacity: 0.4 },
});
