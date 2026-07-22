import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type { RemoteApprovalPolicy, RemoteReasoningEffort, RemoteSandboxMode } from "@rhzycode/protocol";
import { Brain } from "lucide-react-native";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme";

interface TaskMenuProps {
  visible: boolean;
  approvalPolicy: RemoteApprovalPolicy;
  reasoningEffort: RemoteReasoningEffort;
  reasoningEfforts: RemoteReasoningEffort[];
  sandboxMode: RemoteSandboxMode;
  modelPickerEnabled: boolean;
  selectedModelLabel: string | null;
  onApprovalPolicyChange: (value: RemoteApprovalPolicy) => void;
  onClose: () => void;
  onOpenModelPicker: () => void;
  onReasoningEffortChange: (value: RemoteReasoningEffort) => void;
  onSandboxModeChange: (value: RemoteSandboxMode) => void;
}

export function TaskMenu(props: TaskMenuProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={props.onClose} statusBarTranslucent transparent visible={props.visible}>
      <Pressable accessibilityLabel="关闭任务菜单" onPress={props.onClose} style={styles.scrim} />
      <View style={[styles.menu, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title}>任务设置</Text>
          <Pressable accessibilityLabel="关闭" hitSlop={8} onPress={props.onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
            <Ionicons color={colors.ink} name="close" size={21} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Pressable
            accessibilityRole="button"
            disabled={!props.modelPickerEnabled}
            onPress={() => { props.onClose(); props.onOpenModelPicker(); }}
            style={({ pressed }) => [styles.modelRow, !props.modelPickerEnabled && styles.disabled, pressed && styles.pressed]}
          >
            <View style={styles.modelIcon}>
              <MaterialCommunityIcons color={colors.ink} name="robot-outline" size={20} />
            </View>
            <View style={styles.modelText}>
              <Text style={styles.modelLabel}>模型</Text>
              <Text numberOfLines={1} style={styles.modelValue}>{props.selectedModelLabel || "选择模型"}</Text>
            </View>
            <Feather color={colors.inkMuted} name="chevron-right" size={17} />
          </Pressable>
          <View style={styles.divider} />
          <OptionGroup
            icon="folder"
            label="文件权限"
            options={[
              { label: "只读", value: "read-only" },
              { label: "可编辑", value: "workspace-write" },
              { label: "完全访问", value: "danger-full-access" },
            ]}
            selected={props.sandboxMode}
            onSelect={props.onSandboxModeChange}
          />
          <OptionGroup
            icon="shield"
            label="审批方式"
            options={[
              { label: "按需询问", value: "on-request" },
              { label: "不受信时", value: "untrusted" },
              { label: "从不询问", value: "never" },
            ]}
            selected={props.approvalPolicy}
            onSelect={props.onApprovalPolicyChange}
          />
          {props.reasoningEfforts.length > 0 && (
            <OptionGroup
              icon="brain"
              label="推理强度"
              options={props.reasoningEfforts.map((value) => ({ label: effortLabel(value), value }))}
              selected={props.reasoningEffort}
              onSelect={props.onReasoningEffortChange}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function effortLabel(value: RemoteReasoningEffort): string {
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function OptionGroup<T extends string>({ icon, label, onSelect, options, selected }: {
  icon: "brain" | React.ComponentProps<typeof Feather>["name"];
  label: string;
  onSelect: (value: T) => void;
  options: Array<{ label: string; value: T }>;
  selected: T;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.groupLabel}>
        {icon === "brain"
          ? <Brain color={colors.inkMuted} size={14} />
          : <Feather color={colors.inkMuted} name={icon} size={14} />}
        <Text style={styles.groupLabelText}>{label}</Text>
      </View>
      <View style={styles.segmented}>
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              key={option.value}
              onPress={() => onSelect(option.value)}
              style={({ pressed }) => [styles.segment, active && styles.segmentActive, pressed && styles.pressed]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.overlay },
  menu: { position: "absolute", right: 0, bottom: 0, left: 0, maxHeight: "88%", borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.surface, shadowColor: "#000000", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.14, shadowRadius: 12, elevation: 10 },
  handle: { width: 36, height: 4, alignSelf: "center", marginTop: 8, borderRadius: 2, backgroundColor: colors.borderStrong },
  header: { height: 52, paddingLeft: 18, paddingRight: 8, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  title: { flex: 1, color: colors.ink, fontSize: 15, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  closeButton: { width: 38, height: 38, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 },
  modelRow: { minHeight: 58, paddingHorizontal: 8, borderRadius: 7, flexDirection: "row", alignItems: "center" },
  modelIcon: { width: 38, height: 38, marginRight: 10, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.subtle },
  modelText: { flex: 1, minWidth: 0, marginRight: 10 },
  modelLabel: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  modelValue: { marginTop: 2, color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: "600", letterSpacing: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 8, backgroundColor: colors.border },
  group: { paddingHorizontal: 4, paddingVertical: 9 },
  groupLabel: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 7 },
  groupLabelText: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  segmented: { minHeight: 34, padding: 2, borderRadius: 6, flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.subtle },
  segment: { width: "33.333%", height: 30, minWidth: 0, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  segmentText: { color: colors.inkMuted, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
  segmentTextActive: { color: colors.ink, fontWeight: "600" },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.68 },
});
