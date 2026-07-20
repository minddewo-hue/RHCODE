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
import { buildControlUrl } from "../auth/control-access";
import type { ConnectionStatus, ControlPlaneConnectionState } from "../hooks/use-control-plane";
import type { MobileSession } from "../storage/secure-session";
import { colors } from "../ui/theme";
import type { MobileUpdateStatus } from "../update/mobile-update";

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
  search: string;
  session: MobileSession | null;
  editingConnectionHasKey: boolean;
  connectionStatus: ConnectionStatus;
  draftHost: string;
  draftPort: string;
  accessKey: string;
  connectionBusy: boolean;
  connectionError: string | null;
  connectionMessage: string | null;
  canManageThreads: boolean;
  updateStatus: MobileUpdateStatus;
  onClose: () => void;
  onPageChange: (page: DrawerPage) => void;
  onOpenProjects: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onThreadActions: (thread: ThreadSummary, archived: boolean) => void;
  onSearchChange: (value: string) => void;
  onSelectProject: (projectPath: string | null) => void;
  onRefreshArchived: () => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onKeyChange: (value: string) => void;
  onSaveConnection: () => void;
  onAddConnection: () => void;
  onEditActiveConnection: () => void;
  onSelectConnection: (connectionId: string) => void;
  onForget: () => void;
  onCheckForUpdate: () => void;
  onDownloadUpdate: () => void;
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
  const [searching, setSearching] = useState(false);
  const [projectMenuVisible, setProjectMenuVisible] = useState(false);
  const projects = useMemo(
    () => uniqueProjects(props.threads, props.projectPaths),
    [props.projectPaths, props.threads],
  );
  const visibleThreads = useMemo(
    () => searching || !props.selectedProjectPath
      ? props.threads
      : props.threads.filter((thread) => thread.projectPath === props.selectedProjectPath),
    [props.selectedProjectPath, props.threads, searching],
  );
  const filtered = useMemo(
    () => filterThreads(visibleThreads, searching ? props.search : ""),
    [props.search, searching, visibleThreads],
  );

  useEffect(() => {
    if (props.visible) return;
    setSearching(false);
    setProjectMenuVisible(false);
    props.onSearchChange("");
  }, [props.onSearchChange, props.visible]);

  const closeSearch = () => {
    props.onSearchChange("");
    setSearching(false);
    Keyboard.dismiss();
  };

  return (
    <View style={styles.page}>
      {searching ? (
        <View style={styles.searchHeader}>
          <DrawerIcon accessibilityLabel="返回对话" icon="arrow-back" onPress={closeSearch} />
          <TextInput
            accessibilityLabel="搜索对话"
            autoFocus
            onChangeText={props.onSearchChange}
            onSubmitEditing={() => Keyboard.dismiss()}
            placeholder="搜索对话"
            placeholderTextColor={colors.inkFaint}
            returnKeyType="search"
            style={styles.headerSearchInput}
            value={props.search}
          />
          <DrawerIcon accessibilityLabel="关闭侧边栏" icon="close" onPress={props.onClose} />
        </View>
      ) : (
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Feather color={colors.inverse} name="folder" size={14} />
          </View>
          <Text style={styles.brand}>RHZYCODE</Text>
          <DrawerIcon
            accessibilityLabel="搜索对话"
            icon="search"
            onPress={() => {
              setProjectMenuVisible(false);
              setSearching(true);
            }}
          />
          <DrawerIcon accessibilityLabel="工程目录" icon="folder-outline" onPress={props.onOpenProjects} />
        </View>
      )}

      {!searching && (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setProjectMenuVisible((current) => !current)}
            style={({ pressed }) => [styles.projectSwitcher, pressed && styles.projectSwitcherPressed]}
          >
            <View style={styles.projectIcon}>
              <Feather color={colors.accent} name="folder" size={16} />
            </View>
            <View style={styles.projectSwitcherText}>
              <Text numberOfLines={1} style={styles.projectName}>
                {props.selectedProjectPath ? projectName(props.selectedProjectPath) : "所有项目"}
              </Text>
              <Text numberOfLines={1} style={styles.projectPath}>
                {props.selectedProjectPath || `${projects.length} 个项目`}
              </Text>
            </View>
            <Feather color={colors.inkMuted} name={projectMenuVisible ? "chevron-up" : "chevron-down"} size={16} />
          </Pressable>
          {projectMenuVisible && (
            <View style={[styles.projectMenu, { height: Math.min((projects.length + 1) * 42, 224) }]}>
              <ScrollView nestedScrollEnabled>
              <ProjectOption
                label="所有项目"
                selected={!props.selectedProjectPath}
                onPress={() => {
                  props.onSelectProject(null);
                  setProjectMenuVisible(false);
                }}
              />
              {projects.map((path) => (
                <ProjectOption
                  key={path}
                  label={projectName(path)}
                  selected={props.selectedProjectPath === path}
                  onPress={() => {
                    props.onSelectProject(path);
                    setProjectMenuVisible(false);
                  }}
                />
              ))}
              </ScrollView>
            </View>
          )}
        </>
      )}

      <ScrollView style={styles.threadScroll} contentContainerStyle={styles.threadList} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>{searching ? "搜索结果" : "对话"}</Text>
        {filtered.length === 0 ? (
          <Text style={styles.emptyLabel}>{searching && props.search ? "没有匹配的对话" : "还没有对话"}</Text>
        ) : filtered.map((thread) => (
          <ThreadRow
            canManage={props.canManageThreads}
            current={thread.id === props.selectedThreadId}
            key={thread.id}
            onActions={() => props.onThreadActions(thread, false)}
            onPress={() => props.onSelectThread(thread)}
            thread={thread}
          />
        ))}
      </ScrollView>

      <View style={styles.drawerNav}>
        <View style={styles.connectionSummary}>
          <View style={[styles.connectionDot, connectionDot(props.connectionStatus)]} />
          <Text numberOfLines={1} style={styles.connectionText}>
            {connectionSummaryLabel(props.connections, props.connectionStates)}
          </Text>
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
    connection: "服务连接",
    settings: "设置",
    threads: "对话",
  }[props.page];
  const backPage: DrawerPage = props.page === "archived" || props.page === "computers"
    ? "settings"
    : props.page === "connection" && props.connections.length
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
  const filtered = useMemo(() => filterThreads(props.archivedThreads, ""), [props.archivedThreads]);
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
      {props.connections.length === 0 ? (
        <View style={styles.blankState}>
          <Feather color={colors.inkFaint} name="monitor" size={24} />
          <Text style={styles.blankTitle}>还没有保存电脑</Text>
        </View>
      ) : props.connections.map((connection) => (
        <ComputerConnectionRow
          connection={connection}
          current={connection.id === props.activeConnectionId}
          key={connection.id}
          onPress={() => props.onSelectConnection(connection.id)}
          state={props.connectionStates[connection.id]}
        />
      ))}
    </ScrollView>
  );
}

function ConnectionPage(props: AppDrawerProps) {
  const [showKey, setShowKey] = useState(false);
  return (
    <ScrollView contentContainerStyle={styles.subpageContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.fieldLabel}>本机 IP 地址</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        onChangeText={props.onHostChange}
        placeholder="192.168.1.10"
        placeholderTextColor={colors.inkFaint}
        style={styles.fieldInput}
        value={props.draftHost}
      />
      <Text style={[styles.fieldLabel, styles.nextField]}>端口</Text>
      <TextInput
        keyboardType="number-pad"
        maxLength={5}
        onChangeText={props.onPortChange}
        placeholder="8790"
        placeholderTextColor={colors.inkFaint}
        style={styles.fieldInput}
        value={props.draftPort}
      />
      <Text style={[styles.fieldLabel, styles.nextField]}>KEY</Text>
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
        disabled={props.connectionBusy || !props.draftHost.trim() || !props.draftPort.trim() || (!props.accessKey.trim() && !props.editingConnectionHasKey)}
        onPress={props.onSaveConnection}
        style={({ pressed }) => [styles.connectButton, (props.connectionBusy || !props.draftHost.trim() || !props.draftPort.trim() || (!props.accessKey.trim() && !props.editingConnectionHasKey)) && styles.disabled, pressed && styles.connectButtonPressed]}
      >
        {props.connectionBusy ? <ActivityIndicator color={colors.inverse} size="small" /> : <Feather color={colors.inverse} name="save" size={16} />}
        <Text style={styles.connectButtonText}>验证并保存</Text>
      </Pressable>
      <View style={styles.securityNote}>
        <Feather color={colors.inkMuted} name="lock" size={14} />
        <Text style={styles.securityText}>IP、端口和 KEY 会长期保存在此设备的系统安全存储中。</Text>
      </View>
    </ScrollView>
  );
}

function SettingsPage(props: AppDrawerProps) {
  return (
    <ScrollView contentContainerStyle={styles.subpageContent}>
      <Text style={styles.sectionLabel}>工作区</Text>
      <View style={styles.settingsNavGroup}>
        <NavRow icon="monitor" label="电脑" onPress={() => props.onPageChange("computers")} trailing={String(props.connections.length)} />
        <NavRow icon="archive" label="已归档" onPress={() => props.onPageChange("archived")} trailing={String(props.archivedThreads.length)} />
      </View>

      <Text style={[styles.sectionLabel, styles.settingsSectionLabel]}>连接</Text>
      <View style={styles.settingRow}>
        <View style={[styles.connectionDot, connectionDot(props.connectionStatus)]} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>{connectionLabel(props.connectionStatus)}</Text>
          <Text numberOfLines={2} style={styles.settingDetail}>
            {props.session ? buildControlUrl(props.session.host, props.session.port) : "尚未添加电脑"}
          </Text>
        </View>
      </View>
      <Pressable onPress={props.session ? props.onEditActiveConnection : props.onAddConnection} style={({ pressed }) => [styles.settingLink, pressed && styles.settingLinkPressed]}>
        <Feather color={colors.inkMuted} name="link" size={16} />
        <Text style={styles.settingLinkText}>{props.session ? "修改当前电脑的地址或 KEY" : "添加电脑"}</Text>
        <Feather color={colors.inkMuted} name="chevron-right" size={16} />
      </Pressable>

      <Text style={[styles.sectionLabel, styles.settingsSectionLabel]}>版本更新</Text>
      <View style={styles.settingRow}>
        <Feather color={colors.inkMuted} name="download" size={17} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>RHZYCODE {props.appVersion}</Text>
          <Text numberOfLines={2} style={styles.settingDetail}>{mobileUpdateLabel(props.updateStatus)}</Text>
        </View>
      </View>
      <Pressable
        disabled={props.updateStatus.state === "checking"}
        onPress={props.updateStatus.state === "available" ? props.onDownloadUpdate : props.onCheckForUpdate}
        style={({ pressed }) => [styles.settingLink, props.updateStatus.state === "checking" && styles.disabled, pressed && styles.settingLinkPressed]}
      >
        {props.updateStatus.state === "checking"
          ? <ActivityIndicator color={colors.inkMuted} size="small" />
          : <Feather color={colors.inkMuted} name={props.updateStatus.state === "available" ? "download" : "refresh-cw"} size={16} />}
        <Text style={styles.settingLinkText}>{props.updateStatus.state === "available" ? `下载 ${props.updateStatus.latest.version}` : "检查更新"}</Text>
        <Feather color={colors.inkMuted} name="chevron-right" size={16} />
      </Pressable>

      {!!props.session?.accessKey && (
        <Pressable onPress={props.onForget} style={({ pressed }) => [styles.forgetButton, pressed && styles.forgetPressed]}>
          <Feather color={colors.danger} name="log-out" size={16} />
          <Text style={styles.forgetText}>移除当前电脑</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function mobileUpdateLabel(status: MobileUpdateStatus): string {
  if (status.state === "checking") return "正在检查本机更新服务";
  if (status.state === "available") return `发现新版本 ${status.latest.version}`;
  if (status.state === "current") return "当前已是最新版本";
  if (status.state === "error") return "暂时无法连接更新服务";
  return "等待自动检查";
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
      <View style={styles.threadText}>
        <Text numberOfLines={1} style={[styles.threadTitle, current && styles.threadTitleCurrent]}>{thread.title}</Text>
        <View style={styles.threadMetaRow}>
          <ThreadStatusDot status={thread.status} />
          <Text numberOfLines={1} style={styles.threadMeta}>{threadStatus(thread.status)} · {relativeTime(thread.updatedAt)}</Text>
        </View>
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

  useEffect(() => {
    if (!running) {
      pulse.setValue(0);
      return undefined;
    }

    const animation = Animated.loop(Animated.timing(pulse, {
      toValue: 1,
      duration: 1_100,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [pulse, running]);

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
  state,
  onPress,
}: {
  connection: MobileSession;
  current: boolean;
  state?: ControlPlaneConnectionState;
  onPress: () => void;
}) {
  const host = state?.snapshot.hosts[0];
  const status = state?.status || (connection.accessKey ? "connecting" : "needs_configuration");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: current }}
      onPress={onPress}
      style={({ pressed }) => [styles.hostRow, current && styles.hostRowCurrent, pressed && styles.navRowPressed]}
    >
      <View style={styles.hostIcon}><Feather color={colors.ink} name="monitor" size={17} /></View>
      <View style={styles.hostText}>
        <Text numberOfLines={1} style={styles.hostName}>{host?.name || `${connection.host}:${connection.port}`}</Text>
        <Text numberOfLines={1} style={styles.hostMeta}>
          {buildControlUrl(connection.host, connection.port)}{host ? ` · ${host.activeTaskCount} 个活动任务` : ""}
        </Text>
      </View>
      <View style={[styles.hostBadge, status === "online" && styles.hostBadgeOnline]}>
        <Text style={[styles.hostBadgeText, status === "online" && styles.hostBadgeTextOnline]}>{connectionShortStatus(status)}</Text>
      </View>
      {current && <Feather color={colors.accent} name="check" size={16} style={styles.hostCheck} />}
    </Pressable>
  );
}

function ProjectOption({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.projectOption, selected && styles.projectOptionSelected, pressed && styles.navRowPressed]}
    >
      <Feather color={selected ? colors.accent : colors.inkMuted} name="folder" size={15} />
      <Text numberOfLines={1} style={[styles.projectOptionText, selected && styles.projectOptionTextSelected]}>{label}</Text>
      {selected && <Feather color={colors.accent} name="check" size={15} />}
    </Pressable>
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

function filterThreads(threads: ThreadSummary[], search: string): ThreadSummary[] {
  const term = search.trim().toLocaleLowerCase();
  return [...threads]
    .filter((thread) => !term || `${thread.title} ${thread.projectPath}`.toLocaleLowerCase().includes(term))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function uniqueProjects(threads: ThreadSummary[], additionalPaths: string[] = []): string[] {
  return [...new Set(
    [
      ...additionalPaths,
      ...[...threads]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((thread) => thread.projectPath),
    ].map((projectPath) => projectPath.trim()).filter(Boolean),
  )];
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function connectionDot(status: ConnectionStatus) {
  if (status === "online") return { backgroundColor: colors.accent };
  if (status === "connecting") return { backgroundColor: colors.warning };
  return { backgroundColor: colors.inkFaint };
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

function threadDot(status: ThreadSummary["status"]) {
  if (status === "running") return { backgroundColor: colors.accent };
  if (status === "waiting_for_approval" || status === "waiting_for_input") return { backgroundColor: colors.warning };
  if (status === "failed") return { backgroundColor: colors.danger };
  return { backgroundColor: colors.inkFaint };
}

function threadStatus(status: ThreadSummary["status"]): string {
  return {
    idle: "空闲",
    running: "运行中",
    waiting_for_approval: "等待审批",
    waiting_for_input: "等待回答",
    completed: "已完成",
    failed: "失败",
    interrupted: "已停止",
  }[status];
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, flexDirection: "row", backgroundColor: colors.overlay },
  panel: { width: "86%", maxWidth: 380, backgroundColor: colors.sidebar, shadowColor: "#000", shadowOffset: { width: 4, height: 0 }, shadowOpacity: 0.12, shadowRadius: 14, elevation: 14 },
  scrim: { flex: 1 },
  page: { flex: 1 },
  brandRow: { height: 58, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" },
  brandMark: { width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink, marginRight: 9 },
  brand: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 18, fontWeight: "700", letterSpacing: 0 },
  drawerIcon: { width: 38, height: 38, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  searchHeader: { height: 46, marginHorizontal: 10, marginVertical: 6, paddingHorizontal: 2, borderWidth: 1, borderColor: colors.border, borderRadius: 8, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  headerSearchInput: { flex: 1, minWidth: 0, height: 42, paddingHorizontal: 6, color: colors.ink, fontSize: 14, letterSpacing: 0 },
  projectSwitcher: { minHeight: 48, marginHorizontal: 12, marginTop: 4, paddingHorizontal: 10, borderRadius: 7, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  projectSwitcherPressed: { backgroundColor: colors.pressed },
  projectIcon: { width: 30, height: 30, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentSoft, marginRight: 9 },
  projectSwitcherText: { flex: 1, minWidth: 0, paddingVertical: 6 },
  projectName: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  projectPath: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 1, letterSpacing: 0 },
  projectMenu: { maxHeight: 224, marginHorizontal: 12, marginTop: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.surface },
  projectOption: { height: 42, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 9 },
  projectOptionSelected: { backgroundColor: colors.accentSoft },
  projectOptionText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, letterSpacing: 0 },
  projectOptionTextSelected: { color: colors.accent, fontWeight: "600" },
  threadScroll: { flex: 1 },
  threadList: { paddingHorizontal: 8, paddingTop: 17, paddingBottom: 18 },
  sectionLabel: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, fontWeight: "600", letterSpacing: 0, marginHorizontal: 8, marginBottom: 7, textTransform: "uppercase" },
  emptyLabel: { color: colors.inkMuted, fontSize: 13, lineHeight: 19, paddingHorizontal: 8, paddingVertical: 12, letterSpacing: 0 },
  threadRow: { minHeight: 56, borderRadius: 7, paddingLeft: 10, paddingRight: 5, paddingVertical: 8, flexDirection: "row", alignItems: "center" },
  threadRowCurrent: { backgroundColor: "#e3e3df" },
  threadRowPressed: { backgroundColor: colors.pressed },
  threadText: { flex: 1, minWidth: 0 },
  threadTitle: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "500", letterSpacing: 0 },
  threadTitleCurrent: { fontWeight: "600" },
  threadMetaRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  threadStatusIndicator: { width: 13, height: 13, marginRight: 2, alignItems: "center", justifyContent: "center" },
  threadStatusPulse: { position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  threadStatusDot: { width: 5, height: 5, borderRadius: 3 },
  threadMeta: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, letterSpacing: 0 },
  moreButton: { width: 34, height: 34, borderRadius: 5, alignItems: "center", justifyContent: "center", marginLeft: 3 },
  morePressed: { backgroundColor: colors.pressed },
  drawerNav: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 8, paddingTop: 4 },
  navRow: { height: 42, borderRadius: 6, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  navRowPressed: { backgroundColor: colors.pressed },
  navText: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  navTrailing: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  connectionSummary: { height: 48, paddingLeft: 10, paddingRight: 3, flexDirection: "row", alignItems: "center" },
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
  hostRow: { minHeight: 66, paddingHorizontal: 8, borderRadius: 7, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  hostRowCurrent: { backgroundColor: colors.accentSoft },
  hostIcon: { width: 34, height: 34, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, marginRight: 10 },
  hostText: { flex: 1, minWidth: 0 },
  hostName: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  hostMeta: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 2, letterSpacing: 0 },
  hostBadge: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5, backgroundColor: colors.subtle },
  hostBadgeOnline: { backgroundColor: colors.accentSoft },
  hostBadgeText: { color: colors.inkMuted, fontSize: 10, lineHeight: 13, letterSpacing: 0 },
  hostBadgeTextOnline: { color: colors.accent },
  hostCheck: { marginLeft: 7 },
  metaSection: { marginTop: 24, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  endpoint: { color: colors.ink, fontSize: 12, lineHeight: 18, letterSpacing: 0 },
  fieldLabel: { color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", marginBottom: 7, letterSpacing: 0 },
  nextField: { marginTop: 16 },
  fieldInput: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingHorizontal: 11, color: colors.ink, backgroundColor: colors.surface, fontSize: 13, letterSpacing: 0 },
  keyField: { height: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 7, paddingLeft: 11, paddingRight: 4, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  keyInput: { flex: 1, minWidth: 0, height: 42, color: colors.ink, fontSize: 13, letterSpacing: 0 },
  keyToggle: { width: 38, height: 36, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  connectButton: { height: 44, marginTop: 18, borderRadius: 7, backgroundColor: colors.ink, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  connectButtonPressed: { opacity: 0.82 },
  connectButtonText: { color: colors.inverse, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  disabled: { opacity: 0.5 },
  inlineMessage: { minHeight: 36, marginTop: 10, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  inlineError: { backgroundColor: colors.dangerSoft },
  inlineSuccess: { backgroundColor: colors.accentSoft },
  inlineMessageText: { flex: 1, fontSize: 11, lineHeight: 16, letterSpacing: 0 },
  inlineErrorText: { color: colors.danger },
  inlineSuccessText: { color: colors.accent },
  securityNote: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 18, paddingHorizontal: 2 },
  securityText: { flex: 1, color: colors.inkMuted, fontSize: 11, lineHeight: 16, letterSpacing: 0 },
  settingRow: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, backgroundColor: colors.surface, borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  settingText: { flex: 1, minWidth: 0 },
  settingTitle: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  settingDetail: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 2, letterSpacing: 0 },
  settingLink: { height: 46, paddingHorizontal: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, borderBottomLeftRadius: 7, borderBottomRightRadius: 7, flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: colors.surface },
  settingLinkPressed: { backgroundColor: colors.pressed },
  settingLinkText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, letterSpacing: 0 },
  settingsSectionLabel: { marginTop: 24 },
  settingsNavGroup: { borderRadius: 7, backgroundColor: colors.surface, paddingVertical: 3 },
  forgetButton: { minHeight: 44, marginTop: 28, borderWidth: 1, borderColor: "#e2bab6", borderRadius: 7, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9 },
  forgetPressed: { backgroundColor: colors.dangerSoft },
  forgetText: { color: colors.danger, fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
});
