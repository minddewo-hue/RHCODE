import { Feather, Ionicons } from "@expo/vector-icons";
import type { RemoteApprovalPolicy, RemoteReasoningEffort, RemoteSandboxMode } from "@rhzycode/protocol";
import { Brain } from "lucide-react-native";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme";

interface TaskMenuProps {
  visible: boolean;
  approvalPolicy: RemoteApprovalPolicy;
  reasoningEffort: RemoteReasoningEffort;
  reasoningEfforts: RemoteReasoningEffort[];
  sandboxMode: RemoteSandboxMode;
  canCreateThread: boolean;
  onApprovalPolicyChange: (value: RemoteApprovalPolicy) => void;
  onClose: () => void;
  onNewThread: () => void;
  onReasoningEffortChange: (value: RemoteReasoningEffort) => void;
  onSandboxModeChange: (value: RemoteSandboxMode) => void;
}

export function TaskMenu(props: TaskMenuProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="fade" onRequestClose={props.onClose} statusBarTranslucent transparent visible={props.visible}>
      <Pressable accessibilityLabel="关闭任务菜单" onPress={props.onClose} style={styles.scrim} />
      <View style={[styles.menu, { top: insets.top + 50 }]}>
        <Pressable
          accessibilityRole="button"
          disabled={!props.canCreateThread}
          onPress={() => { props.onClose(); props.onNewThread(); }}
          style={({ pressed }) => [styles.command, !props.canCreateThread && styles.disabled, pressed && styles.pressed]}
        >
          <Ionicons color={colors.ink} name="add" size={20} />
          <Text style={styles.commandText}>新建对话</Text>
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
        <OptionGroup
          icon="brain"
          label="推理强度"
          options={props.reasoningEfforts.map((value) => ({ label: effortLabel(value), value }))}
          selected={props.reasoningEffort}
          onSelect={props.onReasoningEffortChange}
        />
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
  menu: { position: "absolute", right: 10, width: 270, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: 8, shadowColor: "#000000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.16, shadowRadius: 12, elevation: 8 },
  command: { height: 42, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 9 },
  commandText: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: "600", letterSpacing: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6, backgroundColor: colors.border },
  group: { paddingHorizontal: 6, paddingVertical: 7 },
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
