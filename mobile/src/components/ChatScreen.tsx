import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type {
  ApprovalRequest,
  ThreadSummary,
  TimelineItem,
  UserInputAnswers,
  UserInputRequest,
  RemoteTurnAttachment,
  RemoteApprovalPolicy,
  RemoteReasoningEffort,
  RemoteSandboxMode,
} from "@rhzycode/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApprovalOperation, ConnectionStatus } from "../hooks/use-control-plane";
import { colors } from "../ui/theme";
import { TaskMenu } from "./TaskMenu";
import {
  buildChatEntries,
  countActivityEntries,
  isResultEntry,
  type ChatEntry,
  type PendingMessage,
} from "./chat-screen-model";

export type { PendingMessage } from "./chat-screen-model";

interface ChatScreenProps {
  thread: ThreadSummary | null;
  selectedThreadId: string | null;
  timeline: TimelineItem[];
  approvals: ApprovalRequest[];
  userInputs: UserInputRequest[];
  pendingMessages: PendingMessage[];
  connectionStatus: ConnectionStatus;
  connectionNotice: string | null;
  refreshing: boolean;
  canWrite: boolean;
  canCreateThread: boolean;
  canApprove: boolean;
  newThreadDraft: boolean;
  draft: string;
  sending: boolean;
  attachments: RemoteTurnAttachment[];
  interrupting: boolean;
  inputBusyId: string | null;
  approvalOperations: Record<string, ApprovalOperation>;
  onOpenDrawer: () => void;
  onOpenModelPicker: () => void;
  onNewThread: () => void;
  onApprovalPolicyChange: (value: RemoteApprovalPolicy) => void;
  onReasoningEffortChange: (value: RemoteReasoningEffort) => void;
  onSandboxModeChange: (value: RemoteSandboxMode) => void;
  modelPickerEnabled: boolean;
  selectedModelLabel: string | null;
  approvalPolicy: RemoteApprovalPolicy;
  reasoningEffort: RemoteReasoningEffort;
  reasoningEfforts: RemoteReasoningEffort[];
  sandboxMode: RemoteSandboxMode;
  onNoticePress: () => void;
  onRefresh: () => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onAttach: (source: "camera" | "library" | "file") => void;
  onRemoveAttachment: (index: number) => void;
  onInterrupt: () => void;
  onApproval: (id: string, decision: "approved" | "declined") => void;
  onSubmitInput: (id: string, answers: UserInputAnswers) => void;
}

type ConversationPage = "result" | "activity";

const conversationPages: ConversationPage[] = ["result", "activity"];

export function ChatScreen(props: ChatScreenProps) {
  const pagerRef = useRef<FlatList<ConversationPage>>(null);
  const resultListRef = useRef<FlatList<ChatEntry>>(null);
  const activityListRef = useRef<FlatList<ChatEntry>>(null);
  const { width: pageWidth } = useWindowDimensions();
  const [activePage, setActivePage] = useState<ConversationPage>("result");
  const [taskMenuVisible, setTaskMenuVisible] = useState(false);
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const entries = useMemo(() => buildChatEntries(props, activePage === "activity"), [
    activePage,
    props.approvals,
    props.pendingMessages,
    props.selectedThreadId,
    props.timeline,
    props.userInputs,
  ]);
  const resultEntries = useMemo(() => entries.filter(isResultEntry), [entries]);
  const activityEntries = useMemo(() => entries.filter((entry) => !isResultEntry(entry)), [entries]);
  const activityCount = useMemo(() => countActivityEntries(props), [
    props.approvals,
    props.selectedThreadId,
    props.timeline,
    props.userInputs,
  ]);
  const threadRunning = props.thread?.status === "running";
  const composerEnabled = Boolean(
    (props.selectedThreadId || props.newThreadDraft)
    && props.canWrite
    && props.connectionStatus === "online",
  );
  const sendDisabled = !composerEnabled || (!props.draft.trim() && !props.attachments.length) || props.sending;

  useEffect(() => {
    setActivePage("result");
    pagerRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [props.selectedThreadId]);

  const selectPage = (page: ConversationPage) => {
    setActivePage(page);
    pagerRef.current?.scrollToIndex({
      index: conversationPages.indexOf(page),
      animated: true,
    });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.screen}
    >
      <View style={styles.header}>
        <IconButton
          accessibilityLabel="打开侧边栏"
          icon="menu"
          onPress={props.onOpenDrawer}
        />
        <View style={styles.headerTitle}>
          <Text numberOfLines={1} style={styles.title}>
            {props.thread?.title || "新对话"}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.statusDot, statusDotStyle(props.connectionStatus)]} />
            <Text numberOfLines={1} style={styles.subtitle}>
              {headerSubtitle(props.thread, props.connectionStatus)}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <HeaderPageButton
            accessibilityLabel="对话"
            active={activePage === "result"}
            icon="message-circle"
            onPress={() => selectPage("result")}
          />
          <HeaderPageButton
            accessibilityLabel="执行过程"
            active={activePage === "activity"}
            badge={activityCount}
            icon="activity"
            running={threadRunning}
            onPress={() => selectPage("activity")}
          />
          <Pressable
            accessibilityLabel={props.selectedModelLabel ? `切换模型，当前 ${props.selectedModelLabel}` : "切换模型"}
            accessibilityRole="button"
            disabled={!props.modelPickerEnabled}
            hitSlop={8}
            onPress={props.onOpenModelPicker}
            style={({ pressed }) => [
              styles.iconButton,
              !props.modelPickerEnabled && styles.iconDisabled,
              pressed && props.modelPickerEnabled && styles.iconPressed,
            ]}
          >
            <MaterialCommunityIcons color={colors.ink} name="robot-outline" size={22} />
          </Pressable>
          <IconButton
            accessibilityLabel="打开任务菜单"
            icon="ellipsis-horizontal"
            onPress={() => setTaskMenuVisible(true)}
          />
        </View>
      </View>

      <TaskMenu
        approvalPolicy={props.approvalPolicy}
        canCreateThread={props.canCreateThread && props.connectionStatus === "online"}
        onApprovalPolicyChange={props.onApprovalPolicyChange}
        onClose={() => setTaskMenuVisible(false)}
        onNewThread={props.onNewThread}
        onReasoningEffortChange={props.onReasoningEffortChange}
        onSandboxModeChange={props.onSandboxModeChange}
        reasoningEffort={props.reasoningEffort}
        reasoningEfforts={props.reasoningEfforts}
        sandboxMode={props.sandboxMode}
        visible={taskMenuVisible}
      />

      {props.connectionNotice && (
        <Pressable
          accessibilityRole="button"
          onPress={props.onNoticePress}
          style={({ pressed }) => [styles.notice, pressed && styles.noticePressed]}
        >
          <Feather color={colors.warning} name="wifi-off" size={14} />
          <Text numberOfLines={2} style={styles.noticeText}>{props.connectionNotice}</Text>
          <Feather color={colors.inkMuted} name="chevron-right" size={16} />
        </Pressable>
      )}

      <FlatList
        data={conversationPages}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
        horizontal
        keyExtractor={(page) => page}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
          setActivePage(conversationPages[index] || "result");
        }}
        pagingEnabled
        ref={pagerRef}
        renderItem={({ item: page }) => (
          <View style={{ flex: 1, width: pageWidth }}>
            <ConversationList
              activityListRef={activityListRef}
              activePage={page}
              entries={page === "result" ? resultEntries : activityEntries}
              hasThread={Boolean(props.selectedThreadId || props.newThreadDraft)}
              props={props}
              resultListRef={resultListRef}
              visible={activePage === page}
            />
          </View>
        )}
        showsHorizontalScrollIndicator={false}
        style={styles.pager}
      />

      <View style={styles.composerWrap}>
        {!props.canWrite && props.selectedThreadId && (
          <Text style={styles.composerHint}>当前设备只有查看权限</Text>
        )}
        {props.attachments.length > 0 && (
          <View style={styles.attachmentList}>
            {props.attachments.map((attachment, index) => (
              <View key={`${attachment.name}:${index}`} style={styles.attachmentChip}>
                <Ionicons color={colors.inkMuted} name={attachment.kind === "image" ? "image-outline" : "document-outline"} size={15} />
                <Text numberOfLines={1} style={styles.attachmentName}>{attachment.name}</Text>
                <Pressable
                  accessibilityLabel={`Remove ${attachment.name}`}
                  accessibilityRole="button"
                  disabled={props.sending}
                  hitSlop={6}
                  onPress={() => props.onRemoveAttachment(index)}
                >
                  <Ionicons color={colors.inkMuted} name="close" size={16} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={[styles.composer, !composerEnabled && styles.composerDisabled]}>
          <TextInput
            accessibilityLabel="消息"
            editable={composerEnabled}
            multiline
            onChangeText={props.onDraftChange}
            placeholder={composerPlaceholder(props)}
            placeholderTextColor={colors.inkFaint}
            style={styles.composerInput}
            textAlignVertical="top"
            value={props.draft}
          />
          <View style={styles.composerActions}>
            <Pressable
              accessibilityLabel="Choose attachments"
              accessibilityRole="button"
              disabled={!composerEnabled || props.sending || props.attachments.length >= 20}
              onPress={() => setAttachmentMenuVisible(true)}
              style={({ pressed }) => [styles.attachButton, pressed && styles.iconPressed]}
            >
              <Ionicons color={colors.ink} name="attach" size={19} />
            </Pressable>
            {threadRunning && props.canWrite && (
              <Pressable
                accessibilityLabel="停止任务"
                accessibilityRole="button"
                disabled={props.interrupting}
                onPress={props.onInterrupt}
                style={({ pressed }) => [styles.stopButton, pressed && styles.iconPressed]}
              >
                {props.interrupting
                  ? <ActivityIndicator color={colors.ink} size="small" />
                  : <Ionicons color={colors.ink} name="stop" size={17} />}
              </Pressable>
            )}
            <Pressable
              accessibilityLabel="发送消息"
              accessibilityRole="button"
              disabled={sendDisabled}
              onPress={props.onSend}
              style={({ pressed }) => [
                styles.sendButton,
                sendDisabled && styles.sendButtonDisabled,
                pressed && !sendDisabled && styles.sendButtonPressed,
              ]}
            >
              {props.sending
                ? <ActivityIndicator color={colors.inverse} size="small" />
                : <Feather color={colors.inverse} name="send" size={17} />}
            </Pressable>
          </View>
        </View>
      </View>
      <AttachmentMenu
        onClose={() => setAttachmentMenuVisible(false)}
        onSelect={(source) => {
          setAttachmentMenuVisible(false);
          props.onAttach(source);
        }}
        visible={attachmentMenuVisible}
      />
    </KeyboardAvoidingView>
  );
}

function AttachmentMenu({ onClose, onSelect, visible }: {
  onClose: () => void;
  onSelect: (source: "camera" | "library" | "file") => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} statusBarTranslucent transparent visible={visible}>
      <Pressable accessibilityLabel="关闭附件菜单" onPress={onClose} style={styles.attachmentMenuScrim} />
      <View style={[styles.attachmentMenu, { paddingBottom: Math.max(insets.bottom, 18) }]}>
        <View style={styles.attachmentMenuHandle} />
        <Text style={styles.attachmentMenuTitle}>添加附件</Text>
        <View style={styles.attachmentMenuOptions}>
          <AttachmentMenuOption icon="camera-outline" label="拍照" onPress={() => onSelect("camera")} />
          <AttachmentMenuOption icon="images-outline" label="相册" onPress={() => onSelect("library")} />
          <AttachmentMenuOption icon="document-outline" label="文件" onPress={() => onSelect("file")} />
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.attachmentMenuCancel, pressed && styles.iconPressed]}>
          <Text style={styles.attachmentMenuCancelText}>取消</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function AttachmentMenuOption({ icon, label, onPress }: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.attachmentMenuOption, pressed && styles.iconPressed]}>
      <View style={styles.attachmentMenuIcon}>
        <Ionicons color={colors.ink} name={icon} size={24} />
      </View>
      <Text style={styles.attachmentMenuOptionText}>{label}</Text>
    </Pressable>
  );
}

function HeaderPageButton({ accessibilityLabel, active, badge, icon, onPress, running = false }: {
  accessibilityLabel: string;
  active: boolean;
  badge?: number;
  icon: "activity" | "message-circle";
  onPress: () => void;
  running?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, busy: running }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerPageButton,
        active && styles.headerPageButtonActive,
        pressed && styles.iconPressed,
      ]}
    >
      {icon === "activity"
        ? <ActivityWaveIcon active={active} running={running} />
        : <Feather color={active ? colors.ink : colors.inkMuted} name={icon} size={19} />}
      {!!badge && (
        <View style={styles.headerPageBadge}>
          <Text style={styles.headerPageBadgeText}>
            {badge > 99 ? "99+" : badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function ActivityWaveIcon({ active, running }: { active: boolean; running: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!running) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 460, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 590, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, running]);

  return (
    <Animated.View
      style={{
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [running ? 0.62 : 1, 1] }),
        transform: [{ scaleY: pulse.interpolate({ inputRange: [0, 1], outputRange: [running ? 0.72 : 1, 1.22] }) }],
      }}
    >
      <Feather color={active ? colors.ink : colors.inkMuted} name="activity" size={19} />
    </Animated.View>
  );
}

function ConversationList({ activityListRef, activePage, entries, hasThread, props, resultListRef, visible }: {
  activityListRef: React.RefObject<FlatList<ChatEntry> | null>;
  activePage: ConversationPage;
  entries: ChatEntry[];
  hasThread: boolean;
  props: ChatScreenProps;
  resultListRef: React.RefObject<FlatList<ChatEntry> | null>;
  visible: boolean;
}) {
  const listRef = activePage === "result" ? resultListRef : activityListRef;
  const [visibleCount, setVisibleCount] = useState(10);
  const didInitialScroll = useRef(false);
  const loadingOlder = useRef(false);
  const nearBottom = useRef(true);
  const previousEntryCount = useRef(entries.length);
  const visibleEntries = useMemo(() => entries.slice(-visibleCount), [entries, visibleCount]);

  const scrollToLatest = (animated: boolean) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
    });
  };

  useEffect(() => {
    setVisibleCount(10);
    didInitialScroll.current = false;
    loadingOlder.current = false;
    nearBottom.current = true;
    previousEntryCount.current = entries.length;
  }, [activePage, props.selectedThreadId]);

  useEffect(() => {
    if (!visible || activePage !== "activity" || !entries.length) return;
    nearBottom.current = true;
    scrollToLatest(didInitialScroll.current);
  }, [activePage, entries.length, visible]);

  return (
    <FlatList
      ref={listRef}
      data={visibleEntries}
      keyExtractor={(entry) => entry.id}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={visibleEntries.length ? styles.listContent : styles.emptyListContent}
      refreshControl={(
        <RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} tintColor={colors.ink} />
      )}
      ListEmptyComponent={<EmptyConversation hasThread={hasThread} page={activePage} />}
      onContentSizeChange={() => {
        if (!visibleEntries.length) return;
        if (!didInitialScroll.current) {
          didInitialScroll.current = true;
          scrollToLatest(false);
        } else if (entries.length > previousEntryCount.current && ((activePage === "activity" && visible) || nearBottom.current)) {
          scrollToLatest(true);
        }
        previousEntryCount.current = entries.length;
        loadingOlder.current = false;
      }}
      onLayout={() => {
        if (visibleEntries.length && !didInitialScroll.current) {
          didInitialScroll.current = true;
          scrollToLatest(false);
        }
      }}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        nearBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
        if (contentOffset.y <= 24 && visibleCount < entries.length && !loadingOlder.current) {
          loadingOlder.current = true;
          setVisibleCount((count) => Math.min(entries.length, count + 10));
        }
      }}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      scrollEventThrottle={100}
      renderItem={({ item }) => {
        if (item.type === "timeline") return <TimelineRow item={item.item} />;
        if (item.type === "pending") return <PendingMessageRow message={item.message} />;
        if (item.type === "approval") {
          return (
            <ApprovalRow
              approval={item.approval}
              canApprove={props.canApprove}
              operation={props.approvalOperations[item.approval.id]}
              onDecision={props.onApproval}
            />
          );
        }
        return (
          <UserInputRow
            request={item.request}
            busy={props.inputBusyId === item.request.id}
            canWrite={props.canWrite}
            onSubmit={props.onSubmitInput}
          />
        );
      }}
    />
  );
}

function IconButton({
  accessibilityLabel,
  icon,
  onPress,
  disabled = false,
}: {
  accessibilityLabel: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, disabled && styles.iconDisabled, pressed && !disabled && styles.iconPressed]}
    >
      <Ionicons color={colors.ink} name={icon} size={22} />
    </Pressable>
  );
}

function EmptyConversation({ hasThread, page }: { hasThread: boolean; page: ConversationPage }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.codexMark}>
        <Feather color={colors.inverse} name={page === "result" ? "message-square" : "terminal"} size={19} />
      </View>
      <Text style={styles.emptyTitle}>
        {page === "activity" ? "暂无执行过程" : hasThread ? "对话已就绪" : "开始一个任务"}
      </Text>
    </View>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.kind === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text selectable style={styles.userText}>{item.content || item.title}</Text>
          <View style={styles.userBubbleTail} />
        </View>
      </View>
    );
  }
  if (item.kind === "assistant") {
    return (
      <View style={styles.assistantRow}>
        <Text selectable style={styles.assistantText}>{item.content || item.title}</Text>
        {item.status === "running" && <ActivityIndicator color={colors.inkMuted} size="small" style={styles.inlineSpinner} />}
      </View>
    );
  }
  if (isLegacyAgentActivity(item)) {
    const content = item.content.trim();
    if (!content || content === "userMessage" || content === "agentMessage") return null;
    return (
      <View style={styles.assistantRow}>
        <Text selectable style={styles.assistantText}>{content}</Text>
      </View>
    );
  }
  const presentation = activityPresentation(item);
  return (
    <View style={styles.activityRow}>
      <View style={styles.activityHeader}>
        <View style={[styles.activityIcon, { backgroundColor: presentation.background }]}>
          {item.status === "running"
            ? <ActivityIndicator color={presentation.color} size={12} />
            : <Feather color={presentation.color} name={presentation.icon} size={13} />}
        </View>
        <View style={styles.activityBody}>
          <Text numberOfLines={2} style={styles.activityTitle}>{item.title || presentation.label}</Text>
        </View>
      </View>
      {!!item.content && <Text selectable style={styles.activityContent}>{item.content}</Text>}
    </View>
  );
}

function PendingMessageRow({ message }: { message: PendingMessage }) {
  const [previewImage, setPreviewImage] = useState<{ name: string; uri: string } | null>(null);
  return (
    <View style={styles.userRow}>
      <View style={[styles.userBubble, message.state === "failed" && styles.failedBubble]}>
        <Text selectable style={styles.userText}>{message.content}</Text>
        {!!message.images?.length && (
          <View style={styles.messageImages}>
            {message.images.map((image) => (
              <Pressable key={image.name} onPress={() => setPreviewImage(image)}>
                <Image accessibilityLabel={image.name} resizeMode="cover" source={{ uri: image.uri }} style={styles.messageImage} />
              </Pressable>
            ))}
          </View>
        )}
        {message.state !== "failed" && <View style={styles.userBubbleTail} />}
        {message.state !== "sent" && <Text style={[styles.pendingLabel, message.state === "failed" && styles.failedLabel]}>
          {message.state === "failed" ? "发送失败" : "正在发送"}
        </Text>}
      </View>
      <Modal animationType="fade" onRequestClose={() => setPreviewImage(null)} statusBarTranslucent transparent visible={Boolean(previewImage)}>
        <Pressable accessibilityLabel="Close image preview" onPress={() => setPreviewImage(null)} style={styles.imagePreview}>
          {previewImage && <Image resizeMode="contain" source={{ uri: previewImage.uri }} style={styles.previewImage} />}
          <Feather color="#ffffff" name="x" size={24} style={styles.previewClose} />
        </Pressable>
      </Modal>
    </View>
  );
}

function ApprovalRow({
  approval,
  canApprove,
  operation,
  onDecision,
}: {
  approval: ApprovalRequest;
  canApprove: boolean;
  operation?: ApprovalOperation;
  onDecision: (id: string, decision: "approved" | "declined") => void;
}) {
  return (
    <View style={styles.requestCard}>
      <View style={styles.requestHeading}>
        <View style={[styles.requestIcon, { backgroundColor: colors.warningSoft }]}>
          <Feather color={colors.warning} name="shield" size={15} />
        </View>
        <View style={styles.requestHeadingText}>
          <Text style={styles.requestTitle}>{approval.title}</Text>
          <Text style={styles.requestMeta}>{approvalKindLabel(approval.kind)}</Text>
        </View>
      </View>
      {!!approval.detail && <Text selectable style={styles.requestDetail}>{approval.detail}</Text>}
      {operation?.message && (
        <Text style={[styles.operationMessage, operation.tone === "error" && styles.operationError]}>
          {operation.message}
        </Text>
      )}
      <View style={styles.requestActions}>
        <Pressable
          disabled={!canApprove || operation?.busy}
          onPress={() => onDecision(approval.id, "declined")}
          style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]}
        >
          <Text style={styles.secondaryActionText}>拒绝</Text>
        </Pressable>
        <Pressable
          disabled={!canApprove || operation?.busy}
          onPress={() => onDecision(approval.id, "approved")}
          style={({ pressed }) => [styles.primaryAction, pressed && styles.primaryActionPressed]}
        >
          {operation?.busy && <ActivityIndicator color={colors.inverse} size="small" />}
          <Text style={styles.primaryActionText}>{canApprove ? "批准" : "无审批权限"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function UserInputRow({
  request,
  busy,
  canWrite,
  onSubmit,
}: {
  request: UserInputRequest;
  busy: boolean;
  canWrite: boolean;
  onSubmit: (id: string, answers: UserInputAnswers) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = request.questions.every((question) => Boolean(values[question.id]?.trim()));
  const answers = (): UserInputAnswers => Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value.trim())
      .map(([id, value]) => [id, [value.trim()]]),
  );
  return (
    <View style={styles.requestCard}>
      <View style={styles.requestHeading}>
        <View style={[styles.requestIcon, { backgroundColor: colors.infoSoft }]}>
          <Feather color={colors.info} name="message-circle" size={15} />
        </View>
        <View style={styles.requestHeadingText}>
          <Text style={styles.requestTitle}>Agent 需要你的回答</Text>
          <Text style={styles.requestMeta}>等待输入</Text>
        </View>
      </View>
      {request.questions.map((question) => (
        <View key={question.id} style={styles.question}>
          {!!question.header && <Text style={styles.questionHeader}>{question.header}</Text>}
          <Text style={styles.questionText}>{question.question}</Text>
          {!!question.options?.length && (
            <View style={styles.optionList}>
              {question.options.map((option) => {
                const selected = values[question.id] === option.label;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    key={option.label}
                    onPress={() => setValues((current) => ({ ...current, [question.id]: option.label }))}
                    style={({ pressed }) => [
                      styles.option,
                      selected && styles.optionSelected,
                      pressed && styles.optionPressed,
                    ]}
                  >
                    <View style={[styles.radio, selected && styles.radioSelected]}>
                      {selected && <View style={styles.radioDot} />}
                    </View>
                    <View style={styles.optionTextWrap}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      {!!option.description && <Text style={styles.optionDescription}>{option.description}</Text>}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
          {(!question.options || question.isOther) && (
            <TextInput
              accessibilityLabel={question.header || question.question}
              onChangeText={(value) => setValues((current) => ({ ...current, [question.id]: value }))}
              placeholder={question.isOther ? "其他回答" : "输入回答"}
              placeholderTextColor={colors.inkFaint}
              secureTextEntry={question.isSecret}
              style={styles.answerInput}
              value={values[question.id] || ""}
            />
          )}
        </View>
      ))}
      <View style={styles.requestActions}>
        <Pressable
          disabled={!canWrite || busy}
          onPress={() => onSubmit(request.id, {})}
          style={({ pressed }) => [styles.secondaryAction, pressed && styles.secondaryActionPressed]}
        >
          <Text style={styles.secondaryActionText}>跳过</Text>
        </Pressable>
        <Pressable
          disabled={!canWrite || busy || !complete}
          onPress={() => onSubmit(request.id, answers())}
          style={({ pressed }) => [
            styles.primaryAction,
            (!canWrite || busy || !complete) && styles.actionDisabled,
            pressed && styles.primaryActionPressed,
          ]}
        >
          {busy && <ActivityIndicator color={colors.inverse} size="small" />}
          <Text style={styles.primaryActionText}>提交</Text>
        </Pressable>
      </View>
    </View>
  );
}

function composerPlaceholder(props: Pick<ChatScreenProps, "selectedThreadId" | "newThreadDraft" | "canWrite" | "connectionStatus">): string {
  if (!props.selectedThreadId && !props.newThreadDraft) return "点击右上角 + 新建对话";
  if (!props.canWrite) return "当前设备只有查看权限";
  if (props.connectionStatus !== "online") return "电脑连接后可发送消息";
  return "给 Codex 发送消息";
}

function headerSubtitle(thread: ThreadSummary | null, status: ConnectionStatus): string {
  if (status === "needs_configuration") return "尚未配置服务";
  if (status === "connecting") return "正在连接";
  if (status === "offline") return "电脑离线";
  if (!thread) return "已连接";
  return `${threadStatusLabel(thread.status)} · ${projectName(thread.projectPath)}`;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path || "项目";
}

function threadStatusLabel(status: ThreadSummary["status"]): string {
  const labels: Record<ThreadSummary["status"], string> = {
    idle: "空闲",
    running: "运行中",
    waiting_for_approval: "等待审批",
    waiting_for_input: "等待回答",
    completed: "已完成",
    failed: "失败",
    interrupted: "已停止",
  };
  return labels[status];
}

function statusDotStyle(status: ConnectionStatus) {
  if (status === "online") return { backgroundColor: colors.accent };
  if (status === "connecting") return { backgroundColor: colors.warning };
  return { backgroundColor: colors.inkFaint };
}

function approvalKindLabel(kind: ApprovalRequest["kind"]): string {
  return {
    command: "执行命令",
    file_change: "修改文件",
    permission: "提升权限",
    external_tool: "外部工具",
  }[kind];
}

function activityPresentation(item: TimelineItem): {
  background: string;
  color: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
} {
  if (item.status === "failed") {
    return { background: colors.dangerSoft, color: colors.danger, icon: "alert-circle", label: "执行失败" };
  }
  if (item.kind === "file_change") {
    return { background: colors.accentSoft, color: colors.accent, icon: "file-text", label: "文件变更" };
  }
  if (item.kind === "notice") {
    return { background: colors.infoSoft, color: colors.info, icon: "info", label: "提示" };
  }
  return { background: colors.subtle, color: colors.inkMuted, icon: "terminal", label: "执行命令" };
}

function isLegacyAgentActivity(item: TimelineItem): boolean {
  return item.kind === "notice" && /^Agent\s*(活动|Activity)$/i.test(item.title.trim());
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    height: 58,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.canvas,
  },
  headerTitle: { flex: 1, alignItems: "center", paddingHorizontal: 8 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  headerPageButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  headerPageButtonActive: { backgroundColor: colors.subtle },
  headerPageBadge: { position: "absolute", top: 1, right: 0, minWidth: 15, height: 15, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: colors.ink },
  headerPageBadgeText: { color: colors.inverse, fontSize: 9, lineHeight: 11, fontWeight: "600", letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 15, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  statusLine: { flexDirection: "row", alignItems: "center", maxWidth: "100%", marginTop: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  subtitle: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  iconDisabled: { opacity: 0.35 },
  iconPressed: { backgroundColor: colors.pressed },
  notice: {
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.warningSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ecd4a9",
  },
  noticePressed: { opacity: 0.75 },
  noticeText: { flex: 1, color: colors.warning, fontSize: 12, lineHeight: 17, letterSpacing: 0 },
  pager: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 28 },
  emptyListContent: { flexGrow: 1 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 48 },
  codexMark: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: colors.ink },
  emptyTitle: { color: colors.ink, fontSize: 18, lineHeight: 24, fontWeight: "600", letterSpacing: 0, marginTop: 15 },
  userRow: { alignItems: "flex-end", marginBottom: 22 },
  userBubble: { position: "relative", maxWidth: "88%", borderRadius: 8, backgroundColor: "#90dd65", paddingHorizontal: 14, paddingVertical: 10 },
  userBubbleTail: { position: "absolute", top: 12, right: -8, width: 0, height: 0, borderTopWidth: 7, borderBottomWidth: 7, borderLeftWidth: 9, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "#90dd65" },
  failedBubble: { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: "#edc3bf" },
  userText: { color: colors.ink, fontSize: 15, lineHeight: 22, letterSpacing: 0 },
  messageImages: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  messageImage: { width: 148, height: 108, borderRadius: 6, backgroundColor: colors.subtle },
  imagePreview: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "#101310ee" },
  previewImage: { width: "100%", height: "100%" },
  previewClose: { position: "absolute", top: 48, right: 20 },
  pendingLabel: { color: colors.inkFaint, fontSize: 10, lineHeight: 14, marginTop: 5, letterSpacing: 0 },
  failedLabel: { color: colors.danger },
  assistantRow: { minWidth: 0, marginBottom: 20 },
  assistantText: { color: colors.ink, fontSize: 15, lineHeight: 23, letterSpacing: 0 },
  inlineSpinner: { alignSelf: "flex-start", marginTop: 8 },
  activityRow: { marginBottom: 18 },
  activityHeader: { flexDirection: "row", alignItems: "flex-start" },
  activityIcon: { width: 26, height: 26, borderRadius: 5, alignItems: "center", justifyContent: "center", marginRight: 9 },
  activityBody: { flex: 1, minWidth: 0, paddingTop: 2 },
  activityTitle: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  activityContent: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, marginTop: 7, letterSpacing: 0 },
  requestCard: { marginBottom: 22, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: 14 },
  requestHeading: { flexDirection: "row", alignItems: "center" },
  requestIcon: { width: 30, height: 30, borderRadius: 6, alignItems: "center", justifyContent: "center", marginRight: 10 },
  requestHeadingText: { flex: 1, minWidth: 0 },
  requestTitle: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: "600", letterSpacing: 0 },
  requestMeta: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, marginTop: 1, letterSpacing: 0 },
  requestDetail: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, marginTop: 12, padding: 10, borderRadius: 5, backgroundColor: colors.subtle, letterSpacing: 0 },
  requestActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  secondaryAction: { minWidth: 72, height: 36, paddingHorizontal: 14, borderRadius: 6, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  secondaryActionPressed: { backgroundColor: colors.pressed },
  secondaryActionText: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  primaryAction: { minWidth: 78, height: 36, paddingHorizontal: 14, borderRadius: 6, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  primaryActionPressed: { opacity: 0.82 },
  primaryActionText: { color: colors.inverse, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
  actionDisabled: { opacity: 0.35 },
  operationMessage: { color: colors.info, fontSize: 11, lineHeight: 16, marginTop: 9, letterSpacing: 0 },
  operationError: { color: colors.danger },
  question: { marginTop: 14 },
  questionHeader: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0 },
  questionText: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 3, letterSpacing: 0 },
  optionList: { gap: 7, marginTop: 9 },
  option: { minHeight: 42, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center" },
  optionSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionPressed: { opacity: 0.75 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center", marginRight: 9 },
  radioSelected: { borderColor: colors.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  optionTextWrap: { flex: 1, minWidth: 0 },
  optionLabel: { color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
  optionDescription: { color: colors.inkMuted, fontSize: 11, lineHeight: 15, marginTop: 1, letterSpacing: 0 },
  answerInput: { height: 42, marginTop: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 11, color: colors.ink, backgroundColor: colors.surface, fontSize: 13, letterSpacing: 0 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6, backgroundColor: colors.canvas },
  attachmentList: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  attachmentChip: { maxWidth: "100%", height: 32, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface },
  attachmentName: { maxWidth: 220, color: colors.ink, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
  composerHint: { color: colors.warning, fontSize: 11, lineHeight: 15, marginBottom: 5, paddingHorizontal: 4, letterSpacing: 0 },
  composer: { minHeight: 44, maxHeight: 132, flexDirection: "row", alignItems: "flex-end", borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 8, backgroundColor: colors.surface, paddingLeft: 12, paddingRight: 5, paddingVertical: 4 },
  composerDisabled: { backgroundColor: colors.subtle, borderColor: colors.border },
  composerInput: { flex: 1, minHeight: 32, maxHeight: 112, paddingTop: 5, paddingBottom: 4, paddingRight: 7, color: colors.ink, fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  composerActions: { flexDirection: "row", alignItems: "center", gap: 5 },
  attachButton: { width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  attachmentMenuScrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.overlay },
  attachmentMenu: { position: "absolute", right: 0, bottom: 0, left: 0, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.surface, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 18 },
  attachmentMenuHandle: { width: 36, height: 4, alignSelf: "center", borderRadius: 2, backgroundColor: colors.borderStrong },
  attachmentMenuTitle: { marginTop: 12, color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: "600", textAlign: "center", letterSpacing: 0 },
  attachmentMenuOptions: { flexDirection: "row", justifyContent: "space-around", marginTop: 18, marginBottom: 14 },
  attachmentMenuOption: { width: 76, alignItems: "center", paddingVertical: 6, borderRadius: 6 },
  attachmentMenuIcon: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.subtle },
  attachmentMenuOptionText: { marginTop: 7, color: colors.ink, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  attachmentMenuCancel: { height: 42, alignItems: "center", justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  attachmentMenuCancelText: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: "600", letterSpacing: 0 },
  stopButton: { width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.subtle },
  sendButton: { width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  sendButtonDisabled: { backgroundColor: colors.borderStrong },
  sendButtonPressed: { opacity: 0.78 },
});
