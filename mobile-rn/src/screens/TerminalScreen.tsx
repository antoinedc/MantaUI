// TerminalScreen.tsx — a raw PTY terminal for React Native.
//
// Connects to the box's /pty WebSocket, renders output in a scrollable View,
// and provides a TextInput at the bottom for user input. Input is sent as raw
// text (no line editing — the remote shell handles that).
//
// This is a minimal implementation: no ANSI color, no cursor, no resize handling
// beyond the initial size. It's enough to interact with tmux, ssh, git, etc.
// A full xterm.js port would be a future enhancement.

import { useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import { attachPty } from "../api/ptyClient";
import {
  appendToBuffer,
  createPtyBuffer,
  getVisibleLines,
  type PtyBuffer,
} from "../pure/pty";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;
const MAX_LINES = 1000;

export function TerminalScreen(_props: Props) {
  const { route } = _props;
  const { credentials, session } = route.params;
  const sessionName = session.project;
  const windowIdx = session.windowIndex ?? 0;

  const [buffer, setBuffer] = useState<PtyBuffer>(() => createPtyBuffer(MAX_LINES));
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ptyRef = useRef<ReturnType<typeof attachPty> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const inputRef = useRef<TextInput | null>(null);

  // Attach to the PTY on mount.
  useEffect(() => {
    let unmounted = false;

    const handle = attachPty(
      credentials.serverUrl,
      credentials.boxToken,
      sessionName,
      windowIdx,
      { cols: INITIAL_COLS, rows: INITIAL_ROWS },
    );

    ptyRef.current = handle;

    handle.onData((data) => {
      if (unmounted) return;
      setBuffer((prev) => appendToBuffer(prev, data));
      // Auto-scroll to bottom on new output
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 50);
    });

    handle.onClose((reason) => {
      if (unmounted) return;
      setConnected(false);
      if (reason && reason !== "connection closed") {
        setError(`PTY closed: ${reason}`);
      }
    });

    setConnected(true);
    setError(null);

    // Focus the input after a short delay so the keyboard appears.
    setTimeout(() => {
      if (!unmounted) {
        inputRef.current?.focus();
      }
    }, 300);

    return () => {
      unmounted = true;
      handle.close();
      ptyRef.current = null;
    };
  }, [credentials.serverUrl, credentials.boxToken, sessionName, windowIdx]);

  const handleSend = () => {
    const text = input.trimEnd(); // Keep trailing spaces, but remove trailing newline
    if (!text) return;
    // Send with a newline so the remote shell sees it as a complete command
    ptyRef.current?.write(text + "\n");
    setInput("");
  };

  const handleClear = () => {
    setBuffer(createPtyBuffer(MAX_LINES));
  };

  const visibleLines = getVisibleLines(buffer, 100); // Show last 100 lines

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {session.title}
        </Text>
        <View style={styles.headerStatus}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: connected ? colors.running : colors.idle },
            ]}
          />
          <Text style={styles.statusText}>{connected ? "Connected" : "Disconnected"}</Text>
        </View>
        <Text style={styles.headerAction} onPress={handleClear}>
          Clear
        </Text>
      </View>

      {error && <Text style={styles.errorBar}>{error}</Text>}

      {/* Terminal output */}
      <ScrollView
        ref={scrollRef}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
        onContentSizeChange={() => {
          // Auto-scroll on content change
          scrollRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {visibleLines.map((line, idx) => (
          <Text key={idx} style={styles.line} selectable>
            {line || " "}
          </Text>
        ))}
        {visibleLines.length === 0 && (
          <Text style={styles.empty}>
            Connecting to {sessionName}...
          </Text>
        )}
      </ScrollView>

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          placeholder="Type command..."
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="default"
          returnKeyType="send"
          blurOnSubmit={false}
        />
        <Text style={styles.sendButton} onPress={handleSend}>
          Send
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  headerStatus: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  headerAction: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
  },
  errorBar: {
    backgroundColor: colors.dangerBg,
    color: colors.danger,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 12,
  },
  output: {
    flex: 1,
    backgroundColor: colors.terminalBg,
  },
  outputContent: {
    padding: 8,
  },
  line: {
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 18,
    color: colors.terminalText,
    paddingVertical: 1,
  },
  empty: {
    color: colors.textFaint,
    fontSize: 14,
    textAlign: "center",
    marginTop: 20,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.terminalText,
    fontFamily: "Menlo",
    fontSize: 13,
    maxHeight: 80,
  },
  sendButton: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
