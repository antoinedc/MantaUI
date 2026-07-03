// Composer.tsx — the prompt input at the bottom of SessionDetailScreen.
//
// A TextInput + Send button. When a turn is running, the Send button becomes a
// Stop button (abort). The "can I send / what do I send" decision is delegated
// to the pure ../pure/composer module; this component owns only the draft
// state + the onSend / onAbort callbacks and layout.

import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { canSubmitPrompt, preparePrompt } from "../pure/composer";
import { colors } from "../theme";

export function Composer({
  running,
  onSend,
  onAbort,
}: {
  running: boolean;
  /** Called with the trimmed, non-empty prompt text. */
  onSend: (text: string) => void;
  /** Called when the user taps Stop while a turn is running. */
  onAbort: () => void;
}) {
  const [draft, setDraft] = useState("");

  const canSend = canSubmitPrompt(draft, running);

  function send() {
    const text = preparePrompt(draft);
    if (!text || running) return;
    onSend(text);
    setDraft("");
  }

  return (
    <View style={styles.bar}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Send a message…"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        multiline
        editable={!running}
      />
      {running ? (
        <TouchableOpacity
          onPress={onAbort}
          style={[styles.btn, styles.stop]}
          accessibilityLabel="Stop"
        >
          <Text style={styles.stopText}>Stop</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={send}
          disabled={!canSend}
          style={[styles.btn, styles.send, !canSend && styles.btnDisabled]}
          accessibilityLabel="Send"
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.surface,
  },
  btn: {
    paddingHorizontal: 16,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: { opacity: 0.4 },
  send: { backgroundColor: colors.accent },
  sendText: { color: colors.bg, fontSize: 14, fontWeight: "600" },
  stop: { backgroundColor: colors.danger },
  stopText: { color: colors.bg, fontSize: 14, fontWeight: "600" },
});
