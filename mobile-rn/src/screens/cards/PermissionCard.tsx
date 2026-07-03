// PermissionCard.tsx — RN port of the desktop Cards.tsx PermissionCard.
//
// Rendered above the composer when opencode has paused a tool waiting for
// approval. Surfaces the category + filepath/command detail and the three
// reply actions that map to opencode's /permission/{id}/reply enum:
//   - once   — allow this single execution
//   - always — allow + save the "always" scope for future auto-approval
//   - reject — deny; the tool errors out
//
// All decision logic (id/detail/scope derivation, reply value) lives in the
// pure ../../pure/interaction module; this component owns only layout + the
// onReply callback.

import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import {
  permissionReplyValue,
  type PermissionReply,
  type PermissionVM,
} from "../../pure/interaction";
import { colors } from "../../theme";

export function PermissionCard({
  perm,
  onReply,
  busy,
}: {
  perm: PermissionVM;
  onReply: (reply: PermissionReply) => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.glyph}>✻</Text>
        <Text style={styles.title}>Permission needed</Text>
        <Text style={styles.category}>· {perm.permission}</Text>
      </View>
      {perm.detail ? (
        <Text style={styles.detail} numberOfLines={3}>
          {perm.detail}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <TouchableOpacity
          disabled={busy}
          onPress={() => onReply(permissionReplyValue("once"))}
          style={[styles.btn, busy && styles.btnDisabled]}
        >
          <Text style={styles.btnText}>Allow once</Text>
        </TouchableOpacity>
        {perm.alwaysScope ? (
          <TouchableOpacity
            disabled={busy}
            onPress={() => onReply(permissionReplyValue("always"))}
            style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
          >
            <Text style={styles.btnPrimaryText} numberOfLines={1}>
              Always allow {perm.alwaysScope}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          disabled={busy}
          onPress={() => onReply(permissionReplyValue("reject"))}
          style={[styles.btn, styles.btnDanger, busy && styles.btnDisabled]}
        >
          <Text style={styles.btnDangerText}>Reject</Text>
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
    gap: 6,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  glyph: { color: colors.accent, fontSize: 14 },
  title: { color: colors.text, fontSize: 13, fontWeight: "600" },
  category: { color: colors.textFaint, fontSize: 13 },
  detail: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: "monospace",
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  btn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: colors.text, fontSize: 13 },
  btnPrimary: { backgroundColor: colors.accent, borderColor: "transparent" },
  btnPrimaryText: { color: colors.bg, fontSize: 13, fontWeight: "600" },
  btnDanger: { borderColor: colors.danger },
  btnDangerText: { color: colors.danger, fontSize: 13 },
});
