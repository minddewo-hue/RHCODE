import { Feather, Ionicons } from "@expo/vector-icons";
import type { ThreadSummary } from "@rhzycode/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
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
import type { ConnectionStatus, ControlPlaneConnectionState } from "../hooks/use-control-plane";
import type { MobileSession } from "../storage/secure-session";
import { colors, createThemedStyles, type ThemeMode } from "../ui/theme";
import { filterThreadsInOrder, groupThreadsByProject, isSameProjectPath, registeredProjectPaths } from "../state/project-list";
import type { MobileUpdateStatus } from "../platform/update/mobile-update";

export type DrawerPage = "threads" | "archived" | "computers" | "connection" | "settings";

interface AppDrawerProps {
  appVersion: string;
  visible: boolean;
  page: DrawerPage;
  threads: ThreadSummary[];
  projectPaths: string[];
  archivedThreads: ThreadSummary[];
  archivedLoading: boolean;
  connections: MobileSession[];
  activeConnectionId: string | null;
  connectionStates: Record<string, ControlPlaneConnectionState>;
  selectedThreadId: string | null;
  selectedProjectPath: string | null;
  collapsedProjectPaths: string[];
  search: string;
  editingConnectionId: string | null;
  editingConnectionHasKey: boolean;
  connectionStatus: ConnectionStatus;
  accessKey: string;
  connectionBusy: boolean;
  connectionError: string | null;
  connectionMessage: string | null;
  canManageThreads: boolean;
  updateStatus: MobileUpdateStatus;
  themeMode: ThemeMode;
  onClose: () => void;
  onPageChange: (page: DrawerPage) => void;
  onOpenProjects: () => void;
  onNewThread: (projectPath?: string) => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onThreadActions: (thread: ThreadSummary, archived: boolean) => void;
  onSearchChange: (value: string) => void;
  onRemoveProject: (projectPath: string) => void;
  onToggleProject: (projectPath: string) => void;
  onRefreshArchived: () => void;
  onKeyChange: (value: string) => void;
  onSaveConnection: () => void;
  onAddConnection: () => void;
  onEditConnection: (connectionId: string) => void;
  onSelectConnection: (connectionId: string) => void;
  onRemoveConnection: () => void;
  onCheckForUpdate: () => void;
  onDownloadUpdate: () => void;
  onThemeModeChange: (mode: ThemeMode) => void;
}

export function AppDrawer(props: AppDrawerProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="fade"
      onRequestClose={props.onClose}
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalRoot}>
        <View style={[styles.panel, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }]}>
          {props.page === "threads" ? <ThreadList {...props} /> : <DrawerSubpage {...props} />}
        </View>
        <Pressable accessibilityLabel="关闭侧边栏" onPress={props.onClose} style={styles.scrim} />
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ThreadList(props: AppDrawerProps) {
  const projectLongPressHandledRef = useRef(false);
  const projects = useMemo(
    () => registeredProjectPaths(props.projectPaths),
    [props.projectPaths],
  );
  const projectGroups = useMemo(
    () => groupThreadsByProject(projects, props.threads, props.search),
    [projects, props.search, props.threads],
  );

  useEffect(() => {
    if (props.visible) return;
    props.onSearchChange("");
  }, [props.onSearchChange, props.visible]);

  const projectActionsDisabled = !props.canManageThreads || props.connectionStatus !== "online";

  return (
    <View style={styles.page}>
      <View style={styles.projectSectionHeader}>
        <Text style={styles.projectSectionTitle}>项目</Text>
        <View style={styles.projectSectionActions}>
          <Pressable
            accessibilityLabel="打开项目文件夹"
            disabled={projectActionsDisabled}
            hitSlop={6}
            onPress={props.onOpenProjects}
            style={({ pressed }) => [styles.projectSectionAction, projectActionsDisabled && styles.disabled, pressed && styles.morePressed]}
          >
            <Feather color={colors.inkMuted} name="folder" size={16} />
          </Pressable>
        </View>
      </View>

      <View style={styles.threadSearch}>
        <Feather color={colors.inkMuted} name="search" size={13} />
        <TextInput
          accessibilityLabel="搜索项目和对话"
          onChangeText={props.onSearchChange}
          onSubmitEditing={() => Keyboard.dismiss()}
          placeholder="搜索项目和对话"
          placeholderTextColor={colors.inkFaint}
          returnKeyType="search"
          style={styles.threadSearchInput}
          value={props.search}
        />
        {Boolean(props.search) && (
          <Pressable
            accessibilityLabel="清除搜索"
            hitSlop={8}
            onPress={() => props.onSearchChange("")}
            style={({ pressed }) => [styles.searchClear, pressed && styles.morePressed]}
          >
            <Feather color={colors.inkMuted} name="x" size={13} />
          </Pressable>
        )}
      </View>

      <ScrollView style={styles.threadScroll} contentContainerStyle={styles.threadList} keyboardShouldPersistTaps="handled">
        {projectGroups.length === 0 ? (
          <Text style={styles.emptyLabel}>{props.search ? "没有匹配的项目或对话" : "打开项目文件夹以开始"}</Text>
        ) : projectGroups.map((group) => {
          const selected = !!props.selectedProjectPath && isSameProjectPath(props.selectedProjectPath, group.path);
          const collapsed = props.collapsedProjectPaths.some((path) => isSameProjectPath(path, group.path)) && !props.search.trim();
          return (
            <View key={group.key} style={styles.projectGroup}>
              <View style={[styles.projectGroupHeader, selected && styles.projectGroupHeaderSelected]}>
                <Pressable
                  accessibilityActions={projectActionsDisabled ? undefined : [{ name: "longpress", label: `移除项目 ${projectName(group.path)}` }]}
                  accessibilityLabel={`${collapsed ? "展开" : "折叠"}项目 ${projectName(group.path)}${projectActionsDisabled ? "" : "，长按移除"}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !collapsed, selected }}
                  delayLongPress={600}
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === "longpress" && !projectActionsDisabled) {
                      props.onRemoveProject(group.path);
                    }
                  }}
                  onLongPress={projectActionsDisabled ? undefined : () => {
                    projectLongPressHandledRef.current = true;
                    props.onRemoveProject(group.path);
                  }}
                  onPress={() => {
                    if (projectLongPressHandledRef.current) return;
                    props.onToggleProject(group.path);
                  }}
                  onPressIn={() => {
                    projectLongPressHandledRef.current = false;
                  }}
                  style={({ pressed }) => [styles.projectGroupMain, pressed && (selected ? styles.projectGroupMainSelectedPressed : styles.projectGroupMainPressed)]}
                >
                  <Feather color={colors.inkMuted} name={collapsed ? "chevron-right" : "chevron-down"} size={14} />
                  <Text numberOfLines={1} style={styles.projectGroupName}>{projectName(group.path)}</Text>
                </Pressable>
                <View style={styles.projectGroupActions}>
                  <Pressable
                    accessibilityLabel={`移除项目 ${projectName(group.path)}`}
                    accessibilityRole="button"
                    disabled={projectActionsDisabled}
                    hitSlop={4}
                    onPress={() => props.onRemoveProject(group.path)}
                    style={({ pressed }) => [styles.projectGroupAction, projectActionsDisabled && styles.disabled, pressed && styles.projectRemovePressed]}
                  >
                    <Feather color={colors.danger} name="trash-2" size={14} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`在项目 ${projectName(group.path)} 中新建对话`}
                    accessibilityRole="button"
                    disabled={projectActionsDisabled}
                    hitSlop={4}
                    onPress={() => props.onNewThread(group.path)}
                    style={({ pressed }) => [styles.projectGroupAction, projectActionsDisabled && styles.disabled, pressed && styles.projectNewPressed]}
                  >
                    <Feather color={colors.accent} name="plus" size={15} />
                  </Pressable>
                </View>
              </View>
              {!collapsed && (
                <View style={styles.projectThreads}>
                  {group.threads.length === 0 ? (
                    <Text style={styles.projectEmpty}>暂无对话</Text>
                  ) : group.threads.map((thread) => (
                    <ThreadRow
                      canManage={props.canManageThreads}
                      current={thread.id === props.selectedThreadId}
                      key={thread.id}
                      onActions={() => props.onThreadActions(thread, false)}
                      onPress={() => props.onSelectThread(thread)}
                      thread={thread}
                    />
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.drawerNav}>
        <View style={styles.connectionSummary}>
          <Pressable
            accessibilityLabel="切换电脑"
            accessibilityRole="button"
            onPress={() => props.onPageChange("computers")}
            style={({ pressed }) => [styles.connectionSummaryButton, pressed && styles.morePressed]}
          >
            <View style={[styles.connectionDot, connectionDot(props.connectionStatus)]} />
            <Text numberOfLines={1} style={styles.connectionText}>
              {connectionSummaryLabel(props.connections, props.connectionStates)}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="设置"
            hitSlop={8}
            onPress={() => props.onPageChange("settings")}
            style={({ pressed }) => [styles.settingsButton, pressed && styles.morePressed]}
          >
            <Feather color={colors.ink} name="settings" size={18} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function DrawerSubpage(props: AppDrawerProps) {
  const title = {
    archived: "已归档",
    computers: "电脑",
    connection: props.editingConnectionId ? "电脑设置" : "添加电脑",
    settings: "设置",
    threads: "对话",
  }[props.page];
  const backPage: DrawerPage = props.page === "archived" || props.page === "computers"
    ? "settings"
    : props.page === "connection"
      ? "computers"
      : "threads";
  return (
    <View style={styles.page}>
      <View style={styles.subHeader}>
        <DrawerIcon accessibilityLabel="返回" icon="arrow-back" onPress={() => props.onPageChange(backPage)} />
        <Text style={styles.subTitle}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      {props.page === "archived" && <ArchivedPage {...props} />}
      {props.page === "computers" && <ComputersPage {...props} />}
      {props.page === "connection" && <ConnectionPage {...props} />}
      {props.page === "settings" && <SettingsPage {...props} />}
    </View>
  );
}

function ArchivedPage(props: AppDrawerProps) {
  const filtered = useMemo(() => filterThreadsInOrder(props.archivedThreads, ""), [props.archivedThreads]);
  return (
    <>
      <View style={styles.archiveHeading}>
        <Text style={styles.archiveCount}>{filtered.length} 个对话</Text>
        {props.archivedLoading
          ? <ActivityIndicator color={colors.inkMuted} size="small" />
          : <Pressable accessibilityLabel="刷新归档" hitSlop={8} onPress={props.onRefreshArchived}><Feather color={colors.inkMuted} name="refresh-cw" size={14} /></Pressable>}
      </View>
      <ScrollView contentContainerStyle={styles.threadList}>
        {filtered.length === 0 && !props.archivedLoading ? (
          <Text style={styles.emptyLabel}>没有已归档对话</Text>
        ) : filtered.map((thread) => (
          <ThreadRow
            canManage={props.canManageThreads}
            current={false}
            key={thread.id}
            onActions={() => props.onThreadActions(thread, true)}
            onPress={() => props.onSelectThread(thread)}
            thread={thread}
          />
        ))}
      </ScrollView>
    </>
  );
}

function ComputersPage(props: AppDrawerProps) {
  return (
    <ScrollView contentContainerStyle={styles.subpageContent}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>已保存的电脑</Text>
        <Pressable onPress={props.onAddConnection} style={({ pressed }) => [styles.smallAction, pressed && styles.smallActionPressed]}>
          <Feather color={colors.ink} name="plus" size={15} />
          <Text style={styles.smallActionText}>添加</Text>
        </Pressable>
      </View>
      {props.connectionError && <InlineMessage message={props.connectionError} tone="error" />}
      {props.connections.length === 0 ? (
        <View style={styles.blankState}>
          <Feather color={colors.inkFaint} name="monitor" size={24} />
          <Text style={styles.blankTitle}>还没有保存电脑</Text>
        </View>
      ) : props.connections.map((connection, index) => (
        <ComputerConnectionRow
          connection={connection}
          current={connection.id === props.activeConnectionId}
          fallbackName={`电脑 ${index + 1}`}
          key={connection.id}
          onEdit={() => props.onEditConnection(connection.id)}
          onPress={() => props.onSelectConnection(connection.id)}
          state={props.connectionStates[connection.id]}
        />
      ))}
    </ScrollView>
  );
}

function ConnectionPage(props: AppDrawerProps) {
  const [showKey, setShowKey] = useState(false);
  const editingState = props.editingConnectionId
    ? props.connectionStates[props.editingConnectionId]
    : undefined;
  const editingStatus = editingState?.status || (props.editingConnectionHasKey ? "connecting" : "needs_configuration");
  return (
    <ScrollView contentContainerStyle={styles.subpageContent} keyboardShouldPersistTaps="handled">
      {props.editingConnectionId && (
        <View style={styles.computerSettingSummary}>
          <View style={[styles.connectionDot, connectionDot(editingStatus)]} />
          <View style={styles.settingText}>
            <Text numberOfLines={1} style={styles.settingTitle}>{editingState?.snapshot.hosts[0]?.name || "已保存电脑"}</Text>
            <Text style={styles.settingDetail}>{connectionLabel(editingStatus)}</Text>
          </View>
        </View>
      )}
      <Text style={styles.fieldLabel}>KEY</Text>
      <View style={styles.keyField}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={props.onKeyChange}
          placeholder={props.editingConnectionHasKey ? "留空则继续使用已保存 KEY" : "桌面端生成的 KEY"}
          placeholderTextColor={colors.inkFaint}
          secureTextEntry={!showKey}
          style={styles.keyInput}
          value={props.accessKey}
        />
        <Pressable
          accessibilityLabel={showKey ? "隐藏 KEY" : "显示 KEY"}
          hitSlop={8}
          onPress={() => setShowKey((current) => !current)}
          style={({ pressed }) => [styles.keyToggle, pressed && styles.morePressed]}
        >
          <Feather color={colors.inkMuted} name={showKey ? "eye-off" : "eye"} size={17} />
        </Pressable>
      </View>
      {props.connectionError && <InlineMessage message={props.connectionError} tone="error" />}
      {props.connectionMessage && <InlineMessage message={props.connectionMessage} tone="success" />}
      <Pressable
        disabled={props.connectionBusy || (!props.accessKey.trim() && !props.editingConnectionHasKey)}
        onPress={props.onSaveConnection}
        style={({ pressed }) => [styles.connectButton, (props.connectionBusy || (!props.accessKey.trim() && !props.editingConnectionHasKey)) && styles.disabled, pressed && styles.connectButtonPressed]}
      >
        {props.connectionBusy ? <ActivityIndicator color={colors.onSolid} size="small" /> : <Feather color={colors.onSolid} name="save" size={16} />}
        <Text style={styles.connectButtonText}>验证并保存</Text>
      </Pressable>
      <View style={styles.securityNote}>
        <Feather color={colors.inkMuted} name="lock" size={14} />
        <Text style={styles.securityText}>KEY 只保存在本机系统安全存储中；中转平台不保存 KEY。</Text>
      </View>
      {props.editingConnectionId && (
        <Pressable onPress={props.onRemoveConnection} style={({ pressed }) => [styles.forgetButton, pressed && styles.forgetPressed]}>
          <Feather color={colors.danger} name="trash-2" size={16} />
          <Text style={styles.forgetText}>移除此电脑</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function SettingsPage(props: AppDrawerProps) {
  return (
    <ScrollView contentContainerStyle={styles.subpageContent}>
      <Text style={styles.sectionLabel}>外观</Text>
      <View style={styles.appearanceSetting}>
        <View style={styles.appearanceHeading}>
          <Feather color={colors.inkMuted} name={props.themeMode === "dark" ? "moon" : "sun"} size={17} />
          <View style={styles.settingText}>
            <Text style={styles.settingTitle}>显示模式</Text>
            <Text style={styles.settingDetail}>{props.themeMode === "dark" ? "夜间模式" : "日间模式"}</Text>
          </View>
        </View>
        <View accessibilityRole="radiogroup" style={styles.themeSegmented}>
          {(["light", "dark"] as const).map((mode) => {
            const active = props.themeMode === mode;
            return (
              <Pressable
                accessibilityLabel={mode === "light" ? "日间模式" : "夜间模式"}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                key={mode}
                onPress={() => props.onThemeModeChange(mode)}
                style={({ pressed }) => [styles.themeOption, active && styles.themeOptionActive, pressed && styles.themeOptionPressed]}
              >
                <Feather color={active ? colors.ink : colors.inkMuted} name={mode === "light" ? "sun" : "moon"} size={15} />
                <Text style={[styles.themeOptionText, active && styles.themeOptionTextActive]}>{mode === "light" ? "日间" : "夜间"}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionLabel}>工作区</Text>
      <View style={styles.settingsNavGroup}>
        <NavRow icon="monitor" label="电脑" onPress={() => props.onPageChange("computers")} trailing={String(props.connections.length)} />
        <NavRow icon="archive" label="已归档" onPress={() => props.onPageChange("archived")} trailing={String(props.archivedThreads.length)} />
      </View>

      <Text style={[styles.sectionLabel, styles.settingsSectionLabel]}>版本更新</Text>
      <View style={styles.settingRow}>
        <Feather color={colors.inkMuted} name="download" size={17} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>当前版本 {props.appVersion}</Text>
          <Text numberOfLines={2} style={styles.settingDetail}>{mobileUpdateLabel(props.updateStatus)}</Text>
        </View>
      </View>
      <Pressable
        accessibilityState={{ busy: ["checking", "downloading", "awaiting_permission", "installing"].includes(props.updateStatus.state) }}
        onPress={["available", "downloading", "ready_to_install", "awaiting_permission", "installing"].includes(props.updateStatus.state)
          ? props.onDownloadUpdate
          : props.onCheckForUpdate}
        style={({ pressed }) => [styles.settingLink, pressed && styles.settingLinkPressed]}
      >
        {["checking", "downloading", "awaiting_permission", "installing"].includes(props.updateStatus.state)
          ? <ActivityIndicator color={colors.inkMuted} size="small" />
          : <Feather
              color={colors.inkMuted}
              name={props.updateStatus.state === "available" && props.updateStatus.latest.platform === "ios" ? "external-link" : props.updateStatus.state === "available" ? "download" : "refresh-cw"}
              size={16}
            />}
        <Text style={styles.settingLinkText}>{updateActionLabel(props.updateStatus)}</Text>
        <Feather color={colors.inkMuted} name="chevron-right" size={16} />
      </Pressable>
    </ScrollView>
  );
}

function mobileUpdateLabel(status: MobileUpdateStatus): string {
  if (status.state === "checking") return "正在检查应用更新";
  if (status.state === "downloading") return `正在下载 ${status.latest.version}`;
  if (status.state === "ready_to_install") return `已下载 ${status.latest.version}，可继续安装`;
  if (status.state === "awaiting_permission") return "等待允许安装未知应用";
  if (status.state === "installing") return "已启动系统安装程序";
  if (status.state === "available") return `发现新版本 ${status.latest.version}`;
  if (status.state === "current") return "当前已是最新版本";
  if (status.state === "error") return "暂时无法连接更新服务";
  return "等待自动检查";
}

function updateActionLabel(status: MobileUpdateStatus): string {
  if (status.state === "available") {
    return status.latest.platform === "ios"
      ? `前往 App Store 更新 ${status.latest.version}`
      : `下载并安装 ${status.latest.version}`;
  }
  if (status.state === "downloading") return "正在下载更新";
  if (status.state === "ready_to_install") return "重新打开安装窗口";
  if (status.state === "awaiting_permission") return "等待安装权限";
  if (status.state === "installing") return "正在启动安装";
  return status.state === "checking" ? "正在检查" : "检查更新";
}

function ThreadRow({
  thread,
  current,
  canManage,
  onPress,
  onActions,
}: {
  thread: ThreadSummary;
  current: boolean;
  canManage: boolean;
  onPress: () => void;
  onActions: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.threadRow, current && styles.threadRowCurrent, pressed && styles.threadRowPressed]}
    >
      <ThreadStatusDot status={thread.status} />
      <View style={styles.threadText}>
        <Text numberOfLines={1} style={[styles.threadTitle, current && styles.threadTitleCurrent]}>{thread.title}</Text>
      </View>
      {canManage && (
        <Pressable
          accessibilityLabel={`${thread.title} 的更多操作`}
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            onActions();
          }}
          style={({ pressed }) => [styles.moreButton, pressed && styles.morePressed]}
        >
          <Feather color={colors.inkMuted} name="more-horizontal" size={17} />
        </Pressable>
      )}
    </Pressable>
  );
}

function ThreadStatusDot({ status }: { status: ThreadSummary["status"] }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const running = status === "running";
  const visible = running
    || status === "waiting_for_approval"
    || status === "waiting_for_input"
    || status === "failed";

  useEffect(() => {
    pulse.setValue(0);
    if (!running) return undefined;

    const animation = Animated.loop(Animated.timing(pulse, {
      toValue: 1,
      duration: 1_100,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [pulse, running]);

  if (!visible) return null;
  return (
    <View style={styles.threadStatusIndicator}>
      {running && (
        <Animated.View
          style={[
            styles.threadStatusPulse,
            {
              opacity: pulse.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.72, 0.2, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
            },
          ]}
        />
      )}
      <Animated.View
        style={[
          styles.threadStatusDot,
          threadDot(status),
          running ? {
            opacity: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.72, 1] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.9, 1.25, 0.9] }) }],
          } : undefined,
        ]}
      />
    </View>
  );
}

function ComputerConnectionRow({
  connection,
  current,
  fallbackName,
  state,
  onEdit,
  onPress,
}: {
  connection: MobileSession;
  current: boolean;
  fallbackName: string;
  state?: ControlPlaneConnectionState;
  onEdit: () => void;
  onPress: () => void;
}) {
  const host = state?.snapshot.hosts[0];
  const status = state?.status || (connection.accessKey ? "connecting" : "needs_configuration");
  return (
    <View style={[styles.hostRow, current && styles.hostRowCurrent]}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: current }}
        onPress={onPress}
        style={({ pressed }) => [styles.hostSelect, pressed && styles.navRowPressed]}
      >
        <View style={styles.hostIcon}><Feather color={colors.ink} name="monitor" size={17} /></View>
        <View style={styles.hostText}>
          <Text numberOfLines={1} style={styles.hostName}>{host?.name || fallbackName}</Text>
          <Text numberOfLines={1} style={styles.hostMeta}>
            {host ? `${host.activeTaskCount} 个活动任务` : "等待电脑版上线"}
          </Text>
        </View>
        <View style={[styles.hostBadge, status === "online" && styles.hostBadgeOnline]}>
          <Text style={[styles.hostBadgeText, status === "online" && styles.hostBadgeTextOnline]}>{connectionShortStatus(status)}</Text>
        </View>
        {current && <Feather color={colors.accent} name="check" size={16} style={styles.hostCheck} />}
      </Pressable>
      <Pressable
        accessibilityLabel={`设置 ${host?.name || fallbackName}`}
        hitSlop={4}
        onPress={onEdit}
        style={({ pressed }) => [styles.hostSettings, pressed && styles.morePressed]}
      >
        <Feather color={colors.inkMuted} name="settings" size={16} />
      </Pressable>
    </View>
  );
}

function NavRow({ icon, label, trailing, onPress }: { icon: React.ComponentProps<typeof Feather>["name"]; label: string; trailing?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}>
      <Feather color={colors.inkMuted} name={icon} size={17} />
      <Text style={styles.navText}>{label}</Text>
      {!!trailing && <Text style={styles.navTrailing}>{trailing}</Text>}
      <Feather color={colors.inkFaint} name="chevron-right" size={16} />
    </Pressable>
  );
}

function DrawerIcon({ accessibilityLabel, icon, onPress }: { accessibilityLabel: string; icon: React.ComponentProps<typeof Ionicons>["name"]; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={accessibilityLabel} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.drawerIcon, pressed && styles.morePressed]}>
      <Ionicons color={colors.ink} name={icon} size={21} />
    </Pressable>
  );
}

function InlineMessage({ message, tone }: { message: string; tone: "error" | "success" }) {
  return (
    <View style={[styles.inlineMessage, tone === "error" ? styles.inlineError : styles.inlineSuccess]}>
      <Feather color={tone === "error" ? colors.danger : colors.accent} name={tone === "error" ? "alert-circle" : "check-circle"} size={14} />
      <Text style={[styles.inlineMessageText, tone === "error" ? styles.inlineErrorText : styles.inlineSuccessText]}>{message}</Text>
    </View>
  );
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function connectionDot(status: ConnectionStatus) {
  if (status === "online") return { backgroundColor: colors.accent };
  if (status === "connecting") return { backgroundColor: colors.warning };
  return { backgroundColor: colors.inkFaint };
}

function threadDot(status: ThreadSummary["status"]) {
  if (status === "running") return { backgroundColor: colors.accent };
  if (status === "waiting_for_approval" || status === "waiting_for_input") return { backgroundColor: colors.warning };
  return { backgroundColor: colors.danger };
}

function connectionSummaryLabel(
  connections: MobileSession[],
  states: Record<string, ControlPlaneConnectionState>,
): string {
  if (!connections.length) return "尚未配置电脑";
  const online = connections.filter((connection) => states[connection.id]?.status === "online").length;
  if (connections.length === 1) {
    return connectionLabel(states[connections[0]!.id]?.status || "connecting");
  }
  return `${online}/${connections.length} 台电脑在线`;
}

function connectionShortStatus(status: ConnectionStatus): string {
  return {
    online: "在线",
    connecting: "连接中",
    offline: "离线",
    needs_configuration: "需配置",
  }[status];
}

function connectionLabel(status: ConnectionStatus): string {
  return {
    online: "电脑已连接",
    connecting: "正在连接电脑",
    offline: "电脑离线",
    needs_configuration: "尚未配置服务",
  }[status];
}

const styles = createThemedStyles((colors) => ({
  modalRoot: { flex: 1, flexDirection: "row", backgroundColor: colors.overlay },
  panel: { width: "84%", maxWidth: 320, backgroundColor: colors.sidebar, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border, shadowColor: colors.shadow, shadowOffset: { width: 4, height: 0 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 12 },
  scrim: { flex: 1 },
  page: { flex: 1 },
  drawerIcon: { width: 38, height: 38, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  threadSearch: { height: 34, marginHorizontal: 9, marginBottom: 11, paddingLeft: 10, paddingRight: 6, borderWidth: 1, borderColor: "transparent", borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.subtle },
  threadSearchInput: { flex: 1, minWidth: 0, height: 32, paddingHorizontal: 0, paddingVertical: 0, color: colors.ink, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  searchClear: { width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  threadScroll: { flex: 1 },
  threadList: { paddingHorizontal: 7, paddingBottom: 18 },
  projectSectionHeader: { minHeight: 34, paddingLeft: 15, paddingRight: 10, paddingBottom: 5, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  projectSectionTitle: { color: colors.inkMuted, fontSize: 12, lineHeight: 16, fontWeight: "500", letterSpacing: 0 },
  projectSectionActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  projectSectionAction: { width: 27, height: 27, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  projectGroup: { marginBottom: 10, borderRadius: 6 },
  projectGroupHeader: { minHeight: 36, overflow: "hidden", borderRadius: 6, flexDirection: "row", alignItems: "stretch", backgroundColor: "transparent" },
  projectGroupHeaderSelected: { backgroundColor: colors.subtle },
  projectGroupMain: { minWidth: 0, flex: 1, minHeight: 36, paddingHorizontal: 8, paddingVertical: 5, flexDirection: "row", alignItems: "center", gap: 5 },
  projectGroupMainPressed: { backgroundColor: colors.pressed },
  projectGroupMainSelectedPressed: { backgroundColor: colors.pressed },
  projectGroupName: { minWidth: 0, flex: 1, color: colors.ink, fontSize: 12, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  projectGroupActions: { paddingRight: 4, flexDirection: "row", alignItems: "center", gap: 2 },
  projectGroupAction: { width: 28, minHeight: 32, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  projectRemovePressed: { backgroundColor: colors.dangerSoft },
  projectNewPressed: { backgroundColor: colors.accentSoft },
  projectThreads: { marginTop: 1, marginBottom: 4, paddingLeft: 20 },
  projectEmpty: { minHeight: 32, paddingHorizontal: 9, paddingVertical: 6, color: colors.inkFaint, fontSize: 10, lineHeight: 16, letterSpacing: 0 },
  sectionLabel: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0, marginHorizontal: 8, marginBottom: 7, textTransform: "uppercase" },
  appearanceSetting: { minHeight: 68, marginBottom: 24, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 7, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface },
  appearanceHeading: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 9 },
  themeSegmented: { width: 132, height: 36, padding: 2, borderRadius: 6, flexDirection: "row", backgroundColor: colors.subtle },
  themeOption: { flex: 1, minWidth: 0, borderRadius: 5, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  themeOptionActive: { borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  themeOptionPressed: { opacity: 0.7 },
  themeOptionText: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  themeOptionTextActive: { color: colors.ink, fontWeight: "600" },
  emptyLabel: { color: colors.inkFaint, fontSize: 11, lineHeight: 17, paddingHorizontal: 8, paddingVertical: 18, textAlign: "center", letterSpacing: 0 },
  threadRow: { minHeight: 42, borderRadius: 6, paddingLeft: 8, paddingRight: 4, paddingVertical: 5, flexDirection: "row", alignItems: "center" },
  threadRowCurrent: { backgroundColor: colors.pressed },
  threadRowPressed: { backgroundColor: colors.subtle },
  threadStatusIndicator: { width: 12, height: 12, marginRight: 5, alignItems: "center", justifyContent: "center" },
  threadStatusPulse: { position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  threadStatusDot: { width: 5, height: 5, borderRadius: 3 },
  threadText: { flex: 1, minWidth: 0 },
  threadTitle: { color: colors.inkMuted, fontSize: 14, lineHeight: 20, fontWeight: "400", letterSpacing: 0 },
  threadTitleCurrent: { color: colors.ink, fontWeight: "500" },
  moreButton: { width: 28, height: 28, borderRadius: 5, alignItems: "center", justifyContent: "center", marginLeft: 3 },
  morePressed: { backgroundColor: colors.pressed },
  drawerNav: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 8, paddingTop: 4 },
  navRow: { height: 42, borderRadius: 6, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  navRowPressed: { backgroundColor: colors.pressed },
  navText: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  navTrailing: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  connectionSummary: { height: 48, paddingRight: 3, flexDirection: "row", alignItems: "center" },
  connectionSummaryButton: { flex: 1, height: 40, paddingLeft: 10, borderRadius: 6, flexDirection: "row", alignItems: "center" },
  connectionDot: { width: 7, height: 7, borderRadius: 4, marginRight: 8 },
  connectionText: { flex: 1, color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  settingsButton: { width: 40, height: 40, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  subHeader: { height: 58, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  subTitle: { flex: 1, color: colors.ink, fontSize: 15, lineHeight: 20, fontWeight: "600", textAlign: "center", letterSpacing: 0 },
  headerSpacer: { width: 38, height: 38 },
  subpageContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 30 },
  archiveHeading: { height: 42, marginHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  archiveCount: { color: colors.inkMuted, fontSize: 12, lineHeight: 17, letterSpacing: 0 },
  sectionHeading: { height: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sectionTitle: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: "600", letterSpacing: 0 },
  smallAction: { height: 32, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, flexDirection: "row", gap: 5, alignItems: "center" },
  smallActionPressed: { backgroundColor: colors.pressed },
  smallActionText: { color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0 },
  blankState: { height: 150, alignItems: "center", justifyContent: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  blankTitle: { color: colors.inkMuted, fontSize: 13, lineHeight: 18, marginTop: 10, letterSpacing: 0 },
  hostRow: { minHeight: 66, borderRadius: 7, flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  hostRowCurrent: { backgroundColor: colors.accentSoft },
  hostSelect: { minWidth: 0, flex: 1, minHeight: 66, paddingLeft: 8, flexDirection: "row", alignItems: "center", borderRadius: 7 },
  hostIcon: { width: 34, height: 34, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, marginRight: 10 },
  hostText: { flex: 1, minWidth: 0 },
  hostName: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  hostMeta: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 2, letterSpacing: 0 },
  hostBadge: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5, backgroundColor: colors.subtle },
  hostBadgeOnline: { backgroundColor: colors.accentSoft },
  hostBadgeText: { color: colors.inkMuted, fontSize: 10, lineHeight: 13, letterSpacing: 0 },
  hostBadgeTextOnline: { color: colors.accent },
  hostCheck: { marginLeft: 7 },
  hostSettings: { width: 40, minHeight: 44, marginHorizontal: 2, alignSelf: "center", borderRadius: 6, alignItems: "center", justifyContent: "center" },
  metaSection: { marginTop: 24, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  endpoint: { color: colors.ink, fontSize: 12, lineHeight: 18, letterSpacing: 0 },
  fieldLabel: { color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", marginBottom: 7, letterSpacing: 0 },
  nextField: { marginTop: 16 },
  fieldInput: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingHorizontal: 11, color: colors.ink, backgroundColor: colors.surface, fontSize: 13, letterSpacing: 0 },
  keyField: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingLeft: 11, paddingRight: 4, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  keyInput: { flex: 1, minWidth: 0, height: 42, color: colors.ink, fontSize: 13, letterSpacing: 0 },
  keyToggle: { width: 38, height: 36, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  connectButton: { height: 44, marginTop: 18, borderRadius: 7, backgroundColor: colors.solid, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  connectButtonPressed: { opacity: 0.82 },
  connectButtonText: { color: colors.onSolid, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  disabled: { opacity: 0.5 },
  inlineMessage: { minHeight: 36, marginTop: 10, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  inlineError: { backgroundColor: colors.dangerSoft },
  inlineSuccess: { backgroundColor: colors.accentSoft },
  inlineMessageText: { flex: 1, fontSize: 11, lineHeight: 16, letterSpacing: 0 },
  inlineErrorText: { color: colors.danger },
  inlineSuccessText: { color: colors.accent },
  securityNote: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 18, paddingHorizontal: 2 },
  securityText: { flex: 1, color: colors.inkMuted, fontSize: 11, lineHeight: 16, letterSpacing: 0 },
  computerSettingSummary: { minHeight: 54, marginBottom: 18, paddingHorizontal: 10, borderRadius: 7, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  settingRow: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, backgroundColor: colors.surface, borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  settingText: { flex: 1, minWidth: 0 },
  settingTitle: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  settingDetail: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 2, letterSpacing: 0 },
  settingLink: { height: 46, paddingHorizontal: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, borderBottomLeftRadius: 7, borderBottomRightRadius: 7, flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: colors.surface },
  settingLinkPressed: { backgroundColor: colors.pressed },
  settingLinkText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, letterSpacing: 0 },
  settingsSectionLabel: { marginTop: 24 },
  settingsNavGroup: { borderRadius: 7, backgroundColor: colors.surface, paddingVertical: 3 },
  forgetButton: { minHeight: 44, marginTop: 28, borderWidth: 1, borderColor: colors.danger, borderRadius: 7, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9 },
  forgetPressed: { backgroundColor: colors.dangerSoft },
  forgetText: { color: colors.danger, fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
}));
