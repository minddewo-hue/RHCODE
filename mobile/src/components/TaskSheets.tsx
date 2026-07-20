import { Feather, Ionicons } from "@expo/vector-icons";
import type { RemoteDirectoryBrowseResult, ThreadSummary } from "@rhzycode/protocol";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme";

interface ProjectPickerSheetProps {
  visible: boolean;
  projects: string[];
  selectedProject: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onBrowseComputer: (path?: string) => Promise<RemoteDirectoryBrowseResult | null>;
  onSelect: (projectPath: string) => void;
  onSubmitPath: (projectPath: string, create: boolean) => Promise<string | null>;
}

export function ProjectPickerSheet(props: ProjectPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const [projectPath, setProjectPath] = useState("");
  const [browser, setBrowser] = useState<RemoteDirectoryBrowseResult | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);

  useEffect(() => {
    if (props.visible) {
      setProjectPath("");
      setBrowser(null);
    }
  }, [props.visible]);

  const submit = async (create: boolean) => {
    const trimmed = projectPath.trim();
    if (!trimmed || props.busy) return;
    const selected = await props.onSubmitPath(trimmed, create);
    if (selected) setProjectPath("");
  };

  const browse = async (path?: string) => {
    if (browserBusy) return;
    setBrowserBusy(true);
    try {
      const result = await props.onBrowseComputer(path);
      if (result) setBrowser(result);
    } finally {
      setBrowserBusy(false);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={props.onClose} statusBarTranslucent transparent visible={props.visible}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalRoot}>
        <Pressable accessibilityLabel="关闭工程目录" onPress={props.onClose} style={styles.sheetScrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.projectSheetTitle}>
              <Feather color={colors.accent} name="folder" size={19} />
              <Text style={styles.sheetTitle}>电脑工程目录</Text>
            </View>
            <Pressable accessibilityLabel="关闭" hitSlop={8} onPress={props.onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
              <Ionicons color={colors.ink} name="close" size={21} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetScroll}>
            {browser ? (
              <>
                <View style={styles.browserHeader}>
                  <Pressable onPress={() => browser.path ? void browse(browser.parentPath || undefined) : setBrowser(null)} style={styles.browserBack}>
                    <Ionicons color={colors.ink} name="arrow-back" size={18} />
                  </Pressable>
                  <Text numberOfLines={1} style={styles.browserPath}>{browser.path || "此电脑"}</Text>
                </View>
                {browser.path && (
                  <Pressable onPress={() => props.onSelect(browser.path!)} style={styles.selectCurrentButton}>
                    <Feather color={colors.inverse} name="check" size={15} />
                    <Text style={styles.selectCurrentText}>选择当前目录</Text>
                  </Pressable>
                )}
                {browserBusy ? <ActivityIndicator color={colors.ink} style={styles.browserLoading} /> : browser.directories.map((directory) => (
                  <Pressable key={directory.path} onPress={() => void browse(directory.path)} style={styles.browserRow}>
                    <Feather color={colors.inkMuted} name="folder" size={17} />
                    <Text numberOfLines={1} style={styles.browserName}>{directory.name}</Text>
                    <Feather color={colors.inkFaint} name="chevron-right" size={16} />
                  </Pressable>
                ))}
                {!browserBusy && !browser.directories.length && <Text style={styles.emptyProjects}>此目录没有子文件夹</Text>}
              </>
            ) : <>
            <Text style={styles.fieldLabel}>已同步目录</Text>
            {props.projects.length ? (
              <View style={styles.projectGrid}>
                {props.projects.map((path) => (
                  <Pressable
                    key={path}
                    onPress={() => props.onSelect(path)}
                    style={({ pressed }) => [
                      styles.projectDirectoryRow,
                      props.selectedProject === path && styles.projectChoiceSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Feather color={props.selectedProject === path ? colors.accent : colors.inkMuted} name="folder" size={17} />
                    <View style={styles.projectDirectoryText}>
                      <Text numberOfLines={1} style={[styles.projectChoiceText, props.selectedProject === path && styles.projectChoiceTextSelected]}>{projectName(path)}</Text>
                      <Text numberOfLines={1} style={styles.projectDirectoryPath}>{path}</Text>
                    </View>
                    {props.selectedProject === path && <Feather color={colors.accent} name="check" size={17} />}
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={styles.emptyProjects}>电脑端还没有登记工程目录</Text>
            )}
            <Pressable
              disabled={props.busy}
              onPress={() => void browse()}
              style={({ pressed }) => [styles.chooseComputerButton, props.busy && styles.disabled, pressed && styles.pressed]}
            >
              {props.busy ? <ActivityIndicator color={colors.ink} size="small" /> : <Feather color={colors.ink} name="folder" size={16} />}
              <Text style={styles.chooseComputerText}>打开电脑目录</Text>
              <Feather color={colors.inkMuted} name="chevron-right" size={14} />
            </Pressable>
            <Text style={[styles.fieldLabel, styles.nextField]}>电脑端完整路径</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setProjectPath}
              editable={!props.busy}
              onSubmitEditing={() => void submit(false)}
              placeholder={"D:\\work_space\\project"}
              placeholderTextColor={colors.inkFaint}
              style={styles.fieldInput}
              value={projectPath}
            />
            {props.error && (
              <View style={styles.errorMessage}>
                <Feather color={colors.danger} name="alert-circle" size={14} />
                <Text style={styles.errorText}>{props.error}</Text>
              </View>
            )}
            <View style={styles.projectPathActions}>
              <Pressable
                disabled={!projectPath.trim() || props.busy}
                onPress={() => void submit(false)}
                style={({ pressed }) => [styles.openPathButton, (!projectPath.trim() || props.busy) && styles.disabled, pressed && styles.pressed]}
              >
                <Feather color={colors.ink} name="folder" size={15} />
                <Text style={styles.openPathText}>使用输入路径</Text>
              </Pressable>
              <Pressable
                disabled={!projectPath.trim() || props.busy}
                onPress={() => void submit(true)}
                style={({ pressed }) => [styles.createPathButton, (!projectPath.trim() || props.busy) && styles.disabled, pressed && styles.createButtonPressed]}
              >
                {props.busy ? <ActivityIndicator color={colors.inverse} size="small" /> : <Feather color={colors.inverse} name="folder-plus" size={15} />}
                <Text style={styles.createPathText}>新建文件夹</Text>
              </Pressable>
            </View>
            </>}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

interface ThreadActionsSheetProps {
  visible: boolean;
  thread: ThreadSummary | null;
  archived: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}

export function ThreadActionsSheet(props: ThreadActionsSheetProps) {
  const insets = useSafeAreaInsets();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (props.visible) {
      setRenaming(false);
      setName(props.thread?.title || "");
    }
  }, [props.thread, props.visible]);

  return (
    <Modal animationType="slide" onRequestClose={props.onClose} statusBarTranslucent transparent visible={props.visible}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalRoot}>
        <Pressable accessibilityLabel="关闭会话操作" onPress={props.onClose} style={styles.sheetScrim} />
        <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text numberOfLines={1} style={styles.sheetTitle}>{renaming ? "重命名" : props.thread?.title || "对话"}</Text>
            <Pressable accessibilityLabel="关闭" hitSlop={8} onPress={props.onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
              <Ionicons color={colors.ink} name="close" size={21} />
            </Pressable>
          </View>
          {renaming ? (
            <View style={styles.renameBody}>
              <TextInput
                autoFocus
                maxLength={200}
                onChangeText={setName}
                onSubmitEditing={() => name.trim() && props.onRename(name.trim())}
                selectTextOnFocus
                style={styles.fieldInput}
                value={name}
              />
              {props.error && <Text style={styles.errorText}>{props.error}</Text>}
              <Pressable
                disabled={!name.trim() || props.busy}
                onPress={() => props.onRename(name.trim())}
                style={({ pressed }) => [styles.createButton, (!name.trim() || props.busy) && styles.disabled, pressed && styles.createButtonPressed]}
              >
                {props.busy && <ActivityIndicator color={colors.inverse} size="small" />}
                <Text style={styles.createButtonText}>保存名称</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.actionList}>
              {!props.archived && <ActionRow icon="edit-3" label="重命名" onPress={() => setRenaming(true)} />}
              {props.archived
                ? <ActionRow icon="rotate-ccw" label="取消归档" onPress={props.onUnarchive} />
                : <ActionRow icon="archive" label="归档" onPress={props.onArchive} />}
              <ActionRow danger icon="trash-2" label="删除对话" onPress={props.onDelete} />
              {props.busy && <ActivityIndicator color={colors.ink} size="small" style={styles.actionSpinner} />}
              {props.error && <Text style={styles.errorText}>{props.error}</Text>}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ActionRow({ icon, label, danger = false, onPress }: { icon: React.ComponentProps<typeof Feather>["name"]; label: string; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}>
      <Feather color={danger ? colors.danger : colors.ink} name={icon} size={18} />
      <Text style={[styles.actionLabel, danger && styles.actionDanger]}>{label}</Text>
      <Feather color={danger ? colors.danger : colors.inkFaint} name="chevron-right" size={16} />
    </Pressable>
  );
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  sheetScrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  sheet: { maxHeight: "88%", width: "100%", maxWidth: 640, alignSelf: "center", borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: colors.canvas, paddingHorizontal: 16, paddingTop: 7 },
  actionSheet: { width: "100%", maxWidth: 640, alignSelf: "center", borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: colors.canvas, paddingHorizontal: 16, paddingTop: 7 },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: 5 },
  sheetHeader: { height: 50, flexDirection: "row", alignItems: "center" },
  projectSheetTitle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 },
  sheetTitle: { flex: 1, color: colors.ink, fontSize: 17, lineHeight: 22, fontWeight: "600", letterSpacing: 0 },
  closeButton: { width: 38, height: 38, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.68 },
  sheetScroll: { maxHeight: 440 },
  fieldLabel: { color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", marginBottom: 8, letterSpacing: 0 },
  fieldHeading: { minHeight: 30, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  openProjectButton: { minHeight: 28, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 5 },
  openProjectText: { color: colors.accent, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  projectOpener: { marginBottom: 12, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  creatorLabel: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", marginBottom: 7, letterSpacing: 0 },
  creatorActions: { marginTop: 9, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  creatorCancel: { height: 34, minWidth: 72, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  creatorCancelText: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  creatorConfirm: { height: 34, minWidth: 116, paddingHorizontal: 12, borderRadius: 6, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  creatorConfirmText: { color: colors.inverse, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  nextField: { marginTop: 18 },
  projectScroller: { marginBottom: 10 },
  projectChoice: { height: 35, maxWidth: 180, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, marginRight: 7, flexDirection: "row", gap: 7, alignItems: "center", backgroundColor: colors.surface },
  projectChoiceSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  projectChoiceText: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  projectChoiceTextSelected: { color: colors.accent, fontWeight: "600" },
  projectGrid: { gap: 7 },
  projectDirectoryRow: { minHeight: 54, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 7, flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: colors.surface },
  projectDirectoryText: { flex: 1, minWidth: 0 },
  projectDirectoryPath: { color: colors.inkFaint, fontSize: 10, lineHeight: 14, marginTop: 2, letterSpacing: 0 },
  emptyProjects: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, paddingVertical: 12, letterSpacing: 0 },
  chooseComputerButton: { minHeight: 42, marginTop: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  chooseComputerText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  browserHeader: { height: 42, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  browserBack: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  browserPath: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
  browserRow: { height: 48, paddingHorizontal: 8, flexDirection: "row", gap: 9, alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  browserName: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  browserLoading: { marginVertical: 24 },
  selectCurrentButton: { height: 40, marginVertical: 10, borderRadius: 7, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  selectCurrentText: { color: colors.inverse, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  projectPathActions: { flexDirection: "row", gap: 8, marginTop: 10, paddingBottom: 16 },
  openPathButton: { flex: 1, minHeight: 40, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  openPathText: { color: colors.ink, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  createPathButton: { flex: 1, minHeight: 40, paddingHorizontal: 8, borderRadius: 7, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  createPathText: { color: colors.inverse, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  fieldInput: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingHorizontal: 11, color: colors.ink, backgroundColor: colors.surface, fontSize: 13, letterSpacing: 0 },
  segmented: { height: 42, flexDirection: "row", borderRadius: 7, backgroundColor: colors.pressed, padding: 3 },
  segment: { flex: 1, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  segmentSelected: { backgroundColor: colors.surface, shadowColor: "#000", shadowOpacity: 0.08, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  segmentText: { color: colors.inkMuted, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
  segmentTextSelected: { color: colors.ink, fontWeight: "600" },
  errorMessage: { minHeight: 36, marginTop: 14, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: colors.dangerSoft },
  errorText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 16, letterSpacing: 0, marginTop: 7 },
  createButton: { height: 44, marginTop: 18, borderRadius: 7, backgroundColor: colors.ink, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  createButtonPressed: { opacity: 0.82 },
  createButtonText: { color: colors.inverse, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  disabled: { opacity: 0.4 },
  renameBody: { paddingBottom: 2 },
  actionList: { paddingBottom: 2 },
  actionRow: { height: 50, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: "row", gap: 12, alignItems: "center" },
  actionRowPressed: { backgroundColor: colors.subtle },
  actionLabel: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 19, letterSpacing: 0 },
  actionDanger: { color: colors.danger },
  actionSpinner: { marginTop: 12 },
});
