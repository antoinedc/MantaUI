// QuestionCard.tsx — RN port of the desktop Cards.tsx QuestionCard.
//
// Rendered above the composer when the Question tool asks the user structured
// questions mid-turn. Each request may carry multiple questions; we render one
// block per question with option buttons (single- or multi-select) plus a
// free-text field, then Submit / Cancel(reject).
//
// All answer logic (toggle, build answers, submittability) lives in the pure
// ../../pure/interaction module; this component owns only local selection state
// + layout, and calls onReply(answers) / onReject().

import { useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  buildQuestionAnswers,
  canSubmitQuestion,
  toggleQuestionOption,
  type QuestionVM,
} from "../../pure/interaction";
import { colors } from "../../theme";

export function QuestionCard({
  request,
  onReply,
  onReject,
  busy,
}: {
  request: QuestionVM;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const [selected, setSelected] = useState<Array<Set<string>>>(() =>
    request.questions.map(() => new Set<string>()),
  );
  const [customValues, setCustomValues] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );

  const canSubmit = canSubmitQuestion(selected, customValues) && !busy;

  function toggle(qIdx: number, label: string, multiple: boolean) {
    setSelected((prev) => toggleQuestionOption(prev, qIdx, label, multiple));
  }

  function setCustom(qIdx: number, value: string) {
    setCustomValues((prev) => {
      const next = [...prev];
      next[qIdx] = value;
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    onReply(buildQuestionAnswers(selected, customValues));
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.glyph}>?</Text>
        <Text style={styles.title}>Question</Text>
        <TouchableOpacity
          onPress={onReject}
          disabled={busy}
          style={styles.dismiss}
          accessibilityLabel="Reject question"
        >
          <Text style={styles.dismissText}>×</Text>
        </TouchableOpacity>
      </View>

      {request.questions.map((info, qIdx) => (
        <View key={qIdx} style={styles.question}>
          {info.header ? <Text style={styles.qHeader}>{info.header}</Text> : null}
          {info.question ? <Text style={styles.qBody}>{info.question}</Text> : null}

          {info.options.length > 0 ? (
            <View style={styles.options}>
              {info.options.map((opt) => {
                const isSelected = selected[qIdx]?.has(opt.label);
                return (
                  <TouchableOpacity
                    key={opt.label}
                    disabled={busy}
                    onPress={() => toggle(qIdx, opt.label, info.multiple)}
                    style={[styles.option, isSelected && styles.optionSelected]}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        isSelected && styles.optionTextSelected,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          <TextInput
            value={customValues[qIdx]}
            onChangeText={(v) => setCustom(qIdx, v)}
            editable={!busy}
            placeholder="Or type your own answer…"
            placeholderTextColor={colors.textFaint}
            style={styles.custom}
          />
        </View>
      ))}

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={onReject}
          disabled={busy}
          style={[styles.btn, busy && styles.btnDisabled]}
        >
          <Text style={styles.btnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={submit}
          disabled={!canSubmit}
          style={[styles.btn, styles.btnPrimary, !canSubmit && styles.btnDisabled]}
        >
          <Text style={styles.btnPrimaryText}>Submit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    padding: 12,
    margin: 12,
    gap: 10,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  glyph: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  title: { color: colors.text, fontSize: 13, fontWeight: "600" },
  dismiss: { marginLeft: "auto", paddingHorizontal: 6 },
  dismissText: { color: colors.textFaint, fontSize: 18, lineHeight: 18 },
  question: { gap: 6 },
  qHeader: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  qBody: { color: colors.text, fontSize: 14, lineHeight: 19 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  optionSelected: { backgroundColor: colors.accent, borderColor: "transparent" },
  optionText: { color: colors.text, fontSize: 13 },
  optionTextSelected: { color: colors.bg, fontWeight: "600" },
  custom: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors.text,
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 2,
  },
  btn: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: colors.textMuted, fontSize: 13 },
  btnPrimary: { backgroundColor: colors.accent, borderColor: "transparent" },
  btnPrimaryText: { color: colors.bg, fontSize: 13, fontWeight: "600" },
});
