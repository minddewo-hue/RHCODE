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
import { colors, createThemedStyles } from "../ui/theme";

interface ProjectPickerSheetProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onBrowseComputer: (path?: string) => Promise<RemoteDirectoryBrowseResult | null>;
  onSelect: (projectPath: string) => void;
  onSubmitPath: (projectPath: string, create: boolean) => Promise<string | null>;
}

export function ProjectPickerSheet(props: ProjectPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const [browser, setBrowser] = useState<RemoteDirectoryBrowseResult | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderNameError, setFolderNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.visible) return;
    let active = true;
    setBrowser(null);
    setBrowserBusy(true);
    setCreatingFolder(false);
    setNewFolderName("");
    setFolderNameError(null);
    void props.onBrowseComputer().then((result) => {
      if (active && result) setBrowser(result);
    }).finally(() => {
      if (active) setBrowserBusy(false);
    });
    return () => {
      active = false;
    };
  }, [props.onBrowseComputer, props.visible]);

  const browse = async (path?: string) => {
    if (browserBusy) return;
    setBrowserBusy(true);
    setCreatingFolder(false);
    setNewFolderName("");
    setFolderNameError(null);
    try {
      const result = await props.onBrowseComputer(path);
      if (result) setBrowser(result);
    } finally {
      setBrowserBusy(false);
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!browser?.path || !name || props.busy) return;
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setFolderNameError("请输入单个文件夹名称，不能包含路径分隔符。");
      return;
    }
    setFolderNameError(null);
    const selected = await props.onSubmitPath(childDirectoryPath(browser.path, name), true);
    if (selected) setNewFolderName("");
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
                  <Pressable
                    accessibilityLabel={browser.path ? "返回上级目录" : "关闭电脑工程目录"}
                    disabled={browserBusy || props.busy}
                    onPress={() => browser.path ? void browse(browser.parentPath || undefined) : props.onClose()}
                    style={({ pressed }) => [styles.browserBack, (browserBusy || props.busy) && styles.disabled, pressed && styles.pressed]}
                  >
                    <Ionicons color={colors.ink} name="arrow-back" size={18} />
                  </Pressable>
                  <Text numberOfLines={1} style={styles.browserPath}>{browser.path || "此电脑"}</Text>
                </View>
                {browser.path && (
                  <>
                    <View style={styles.browserActions}>
                      <Pressable
                        disabled={props.busy}
                        onPress={() => props.onSelect(browser.path!)}
                        style={({ pressed }) => [styles.selectCurrentButton, props.busy && styles.disabled, pressed && styles.createButtonPressed]}
                      >
                        {props.busy ? <ActivityIndicator color={colors.onSolid} size="small" /> : <Feather color={colors.onSolid} name="check" size={15} />}
                        <Text style={styles.selectCurrentText}>选择当前目录</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel="在当前目录新建文件夹"
                        disabled={props.busy}
                        onPress={() => {
                          setCreatingFolder(true);
                          setFolderNameError(null);
                        }}
                        style={({ pressed }) => [styles.newFolderButton, props.busy && styles.disabled, pressed && styles.pressed]}
                      >
                        <Feather color={colors.ink} name="folder-plus" size={16} />
                        <Text style={styles.newFolderButtonText}>新建文件夹</Text>
                      </Pressable>
                    </View>
                    {creatingFolder && (
                      <View style={styles.folderCreator}>
                        <Text style={styles.creatorLabel}>在当前目录新建文件夹</Text>
                        <TextInput
                          autoFocus
                          autoCapitalize="none"
                          autoCorrect={false}
                          editable={!props.busy}
                          onChangeText={(value) => {
                            setNewFolderName(value);
                            setFolderNameError(null);
                          }}
                          onSubmitEditing={() => void createFolder()}
                          placeholder="文件夹名称"
                          placeholderTextColor={colors.inkFaint}
                          returnKeyType="done"
                          style={styles.fieldInput}
                          value={newFolderName}
                        />
                        {folderNameError && <Text style={styles.folderNameError}>{folderNameError}</Text>}
                        <View style={styles.creatorActions}>
                          <Pressable
                            disabled={props.busy}
                            onPress={() => {
                              setCreatingFolder(false);
                              setNewFolderName("");
                              setFolderNameError(null);
                            }}
                            style={({ pressed }) => [styles.creatorCancel, props.busy && styles.disabled, pressed && styles.pressed]}
                          >
                            <Text style={styles.creatorCancelText}>取消</Text>
                          </Pressable>
                          <Pressable
                            disabled={!newFolderName.trim() || props.busy}
                            onPress={() => void createFolder()}
                            style={({ pressed }) => [styles.creatorConfirm, (!newFolderName.trim() || props.busy) && styles.disabled, pressed && styles.createButtonPressed]}
                          >
                            {props.busy ? <ActivityIndicator color={colors.onSolid} size="small" /> : <Feather color={colors.onSolid} name="folder-plus" size={15} />}
                            <Text style={styles.creatorConfirmText}>创建并打开</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </>
                )}
                {browserBusy ? <ActivityIndicator color={colors.ink} style={styles.browserLoading} /> : browser.directories.map((directory) => (
                  <Pressable disabled={props.busy} key={directory.path} onPress={() => void browse(directory.path)} style={({ pressed }) => [styles.browserRow, props.busy && styles.disabled, pressed && styles.pressed]}>
                    <Feather color={colors.inkMuted} name="folder" size={17} />
                    <Text numberOfLines={1} style={styles.browserName}>{directory.name}</Text>
                    <Feather color={colors.inkFaint} name="chevron-right" size={16} />
                  </Pressable>
                ))}
                {!browserBusy && !browser.directories.length && <Text style={styles.emptyProjects}>此目录没有子文件夹</Text>}
              </>
            ) : browserBusy ? (
              <ActivityIndicator color={colors.ink} style={styles.initialBrowserLoading} />
            ) : (
              <View style={styles.browserUnavailable}>
                <Text style={styles.emptyProjects}>无法读取电脑目录</Text>
                <Pressable onPress={() => void browse()} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
                  <Feather color={colors.ink} name="refresh-cw" size={15} />
                  <Text style={styles.retryButtonText}>重新加载</Text>
                </Pressable>
              </View>
            )}
            {props.error && (
              <View style={styles.errorMessage}>
                <Feather color={colors.danger} name="alert-circle" size={14} />
                <Text style={styles.errorText}>{props.error}</Text>
              </View>
            )}
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
                {props.busy && <ActivityIndicator color={colors.onSolid} size="small" />}
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

function childDirectoryPath(parentPath: string, childName: string): string {
  const separator = parentPath.includes("\\") ? "\\" : "/";
  return `${parentPath.replace(/[\\/]+$/, "")}${separator}${childName}`;
}

const styles = createThemedStyles((colors) => ({
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
  creatorLabel: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", marginBottom: 7, letterSpacing: 0 },
  creatorActions: { marginTop: 9, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  creatorCancel: { height: 34, minWidth: 72, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  creatorCancelText: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  creatorConfirm: { height: 34, minWidth: 116, paddingHorizontal: 12, borderRadius: 6, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.solid },
  creatorConfirmText: { color: colors.onSolid, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0 },
  emptyProjects: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, paddingVertical: 12, letterSpacing: 0 },
  browserHeader: { height: 42, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  browserBack: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  browserPath: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
  browserRow: { height: 48, paddingHorizontal: 8, flexDirection: "row", gap: 9, alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  browserName: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  browserLoading: { marginVertical: 24 },
  browserActions: { flexDirection: "row", gap: 8, paddingVertical: 10 },
  selectCurrentButton: { flex: 1, minWidth: 0, height: 40, borderRadius: 7, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.solid },
  selectCurrentText: { color: colors.onSolid, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  newFolderButton: { flex: 1, minWidth: 0, height: 40, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  newFolderButtonText: { color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  folderCreator: { paddingHorizontal: 8, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.subtle },
  folderNameError: { color: colors.danger, fontSize: 11, lineHeight: 16, marginTop: 6, letterSpacing: 0 },
  initialBrowserLoading: { marginVertical: 42 },
  browserUnavailable: { alignItems: "center", paddingVertical: 24 },
  retryButton: { height: 36, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  retryButtonText: { color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  fieldInput: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingHorizontal: 11, color: colors.ink, backgroundColor: colors.surface, fontSize: 13, letterSpacing: 0 },
  errorMessage: { minHeight: 36, marginTop: 14, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: colors.dangerSoft },
  errorText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 16, letterSpacing: 0, marginTop: 7 },
  createButton: { height: 44, marginTop: 18, borderRadius: 7, backgroundColor: colors.solid, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  createButtonPressed: { opacity: 0.82 },
  createButtonText: { color: colors.onSolid, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  disabled: { opacity: 0.4 },
  renameBody: { paddingBottom: 2 },
  actionList: { paddingBottom: 2 },
  actionRow: { height: 50, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: "row", gap: 12, alignItems: "center" },
  actionRowPressed: { backgroundColor: colors.subtle },
  actionLabel: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 19, letterSpacing: 0 },
  actionDanger: { color: colors.danger },
  actionSpinner: { marginTop: 12 },
}));
