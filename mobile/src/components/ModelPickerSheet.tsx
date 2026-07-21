import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type { RemoteModelOption } from "@rhzycode/protocol";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme";
import { groupRemoteModels } from "./model-picker-model";

interface ModelPickerSheetProps {
  visible: boolean;
  models: RemoteModelOption[];
  selectedModel: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (model: string) => void;
}

export function ModelPickerSheet(props: ModelPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const modelGroups = useMemo(() => groupRemoteModels(props.models), [props.models]);
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="关闭模型选择" onPress={props.onClose} style={styles.scrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.titleIcon}>
              <MaterialCommunityIcons color={colors.accent} name="robot-outline" size={18} />
            </View>
            <Text style={styles.title}>切换模型</Text>
            <Pressable
              accessibilityLabel="关闭"
              hitSlop={8}
              onPress={props.onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.ink} name="close" size={21} />
            </Pressable>
          </View>

          {props.loading && !props.models.length ? (
            <View style={styles.state}>
              <ActivityIndicator color={colors.inkMuted} size="small" />
            </View>
          ) : props.error && !props.models.length ? (
            <View style={styles.state}>
              <Text style={styles.error}>{props.error}</Text>
              <Pressable onPress={props.onRefresh} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
                <Feather color={colors.ink} name="refresh-cw" size={14} />
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            </View>
          ) : (
            <SectionList
              contentContainerStyle={styles.list}
              keyExtractor={(model) => model.id}
              renderItem={({ item: model }) => {
                const selected = model.model === props.selectedModel;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    key={model.id}
                    onPress={() => props.onSelect(model.model)}
                    style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.pressed]}
                  >
                    <View style={styles.modelText}>
                      <View style={styles.modelTitleRow}>
                        <Text numberOfLines={1} style={[styles.modelName, selected && styles.modelNameSelected]}>
                          {model.sourceModelName}
                        </Text>
                        {model.isDefault && <Text style={styles.defaultLabel}>默认</Text>}
                      </View>
                    </View>
                    {selected && <Feather color={colors.accent} name="check" size={18} />}
                  </Pressable>
                );
              }}
              renderSectionHeader={({ section }) => (
                <View style={styles.groupHeader}>
                  <Text numberOfLines={1} style={styles.groupTitle}>{section.source}</Text>
                  <Text style={styles.groupCount}>{section.data.length}</Text>
                </View>
              )}
              sections={modelGroups.map((group) => ({
                key: group.key,
                source: group.source,
                data: group.models,
              }))}
              stickySectionHeadersEnabled
              style={styles.modelList}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.overlay },
  sheet: { maxHeight: "72%", borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.canvas },
  handle: { width: 34, height: 4, borderRadius: 2, alignSelf: "center", marginTop: 8, backgroundColor: colors.borderStrong },
  header: { height: 58, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  titleIcon: { width: 30, height: 30, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentSoft, marginRight: 9 },
  title: { flex: 1, color: colors.ink, fontSize: 15, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  closeButton: { width: 38, height: 38, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 12, paddingBottom: 8 },
  modelList: { flexShrink: 1 },
  groupHeader: { height: 34, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.canvas, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  groupTitle: { flex: 1, minWidth: 0, color: colors.inkMuted, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  groupCount: { minWidth: 20, color: colors.inkFaint, fontSize: 10, lineHeight: 14, textAlign: "right", letterSpacing: 0 },
  row: { minHeight: 52, paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, borderRadius: 6, flexDirection: "row", alignItems: "center" },
  rowSelected: { backgroundColor: colors.accentSoft },
  modelText: { flex: 1, minWidth: 0, marginRight: 10 },
  modelTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  modelName: { flexShrink: 1, color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  modelNameSelected: { color: colors.accent },
  defaultLabel: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, letterSpacing: 0 },
  state: { minHeight: 180, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18, textAlign: "center", letterSpacing: 0 },
  retryButton: { height: 36, marginTop: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 6 },
  retryText: { color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  pressed: { opacity: 0.72 },
});
