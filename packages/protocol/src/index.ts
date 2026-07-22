import { z } from "zod";

export const hostStatusSchema = z.enum(["online", "offline", "busy"]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const hostSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(["windows", "macos", "linux", "cloud"]),
  status: hostStatusSchema,
  lastSeenAt: z.string().datetime(),
  activeTaskCount: z.number().int().nonnegative(),
});
export type HostSummary = z.infer<typeof hostSummarySchema>;

export const modelSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  reasoningEfforts: z.array(z.string()),
  isDefault: z.boolean(),
});
export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const threadStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const threadSummarySchema = z.object({
  id: z.string().min(1),
  hostId: z.string().min(1),
  title: z.string().min(1),
  projectPath: z.string(),
  model: z.string().min(1),
  status: threadStatusSchema,
  updatedAt: z.string().datetime(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const conversationFileSchema = z.object({
  id: z.string().min(1).max(240),
  name: z.string().min(1).max(240),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(240).optional(),
  source: z.enum(["upload", "generated"]),
  path: z.string().min(1).optional(),
});
export type ConversationFile = z.infer<typeof conversationFileSchema>;

export const timelineItemSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  kind: z.enum(["user", "assistant", "command", "file_change", "notice"]),
  status: z.enum(["pending", "running", "completed", "failed"]),
  title: z.string(),
  content: z.string(),
  images: z.array(z.object({
    id: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    generated: z.boolean().optional(),
  })).max(10).optional(),
  files: z.array(conversationFileSchema.omit({ path: true })).max(20).optional(),
  createdAt: z.string().datetime(),
});
export type TimelineItem = z.infer<typeof timelineItemSchema>;

export const conversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  images: z.array(z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    generated: z.boolean().optional(),
  })).optional(),
  files: z.array(conversationFileSchema).max(20).optional(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const threadDetailSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(conversationMessageSchema),
  timeline: z.array(timelineItemSchema),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  kind: z.enum(["command", "file_change", "permission", "external_tool"]),
  title: z.string().min(1),
  detail: z.string(),
  createdAt: z.string().datetime(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const userInputOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});
export type UserInputOption = z.infer<typeof userInputOptionSchema>;

export const userInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string(),
  question: z.string().min(1),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(userInputOptionSchema).nullable(),
});
export type UserInputQuestion = z.infer<typeof userInputQuestionSchema>;

export const userInputRequestSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  questions: z.array(userInputQuestionSchema).min(1),
  autoResolutionMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
});
export type UserInputRequest = z.infer<typeof userInputRequestSchema>;

export const projectDirectorySchema = z.object({
  path: z.string().min(1).max(32_768),
  name: z.string().min(1).max(500),
});
export type ProjectDirectory = z.infer<typeof projectDirectorySchema>;

export const userInputAnswersSchema = z.record(z.string(), z.array(z.string()));
export type UserInputAnswers = z.infer<typeof userInputAnswersSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.status"),
    sequence: z.number().int().nonnegative(),
    host: hostSummarySchema,
  }),
  z.object({
    type: z.literal("thread.updated"),
    sequence: z.number().int().nonnegative(),
    thread: threadSummarySchema,
  }),
  z.object({
    type: z.literal("thread.removed"),
    sequence: z.number().int().nonnegative(),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("projects.updated"),
    sequence: z.number().int().nonnegative(),
    projects: z.array(projectDirectorySchema).max(500),
  }),
  z.object({
    type: z.literal("timeline.upserted"),
    sequence: z.number().int().nonnegative(),
    item: timelineItemSchema,
  }),
  z.object({
    type: z.literal("approval.requested"),
    sequence: z.number().int().nonnegative(),
    approval: approvalRequestSchema,
  }),
  z.object({
    type: z.literal("approval.resolved"),
    sequence: z.number().int().nonnegative(),
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "declined"]),
  }),
  z.object({
    type: z.literal("user_input.requested"),
    sequence: z.number().int().nonnegative(),
    request: userInputRequestSchema,
  }),
  z.object({
    type: z.literal("user_input.resolved"),
    sequence: z.number().int().nonnegative(),
    requestId: z.string().min(1),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const createTurnRequestSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().min(1),
});
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>;

export const remoteApprovalPolicySchema = z.enum(["on-request", "untrusted", "never"]);
export type RemoteApprovalPolicy = z.infer<typeof remoteApprovalPolicySchema>;

export const remoteSandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type RemoteSandboxMode = z.infer<typeof remoteSandboxModeSchema>;

export const remoteReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type RemoteReasoningEffort = z.infer<typeof remoteReasoningEffortSchema>;

export const remoteProjectListResultSchema = z.object({
  projects: z.array(projectDirectorySchema).max(500),
});
export type RemoteProjectListResult = z.infer<typeof remoteProjectListResultSchema>;

export const remoteModelOptionSchema = z.object({
  id: z.string().min(1).max(500),
  model: z.string().min(1).max(500),
  displayName: z.string().min(1).max(500),
  source: z.string().min(1).max(500).optional(),
  sourceModelName: z.string().min(1).max(500).optional(),
  description: z.string().max(10_000),
  defaultReasoningEffort: z.string().max(500),
  reasoningEfforts: z.array(remoteReasoningEffortSchema).max(20).optional(),
  isDefault: z.boolean().optional(),
});
export type RemoteModelOption = z.infer<typeof remoteModelOptionSchema>;

export const remoteModelListResultSchema = z.object({
  models: z.array(remoteModelOptionSchema).max(500),
});
export type RemoteModelListResult = z.infer<typeof remoteModelListResultSchema>;

export const remoteProjectCreateRequestSchema = z.object({
  path: z.string().trim().min(1).max(32_768),
  create: z.boolean().optional(),
}).strict();
export type RemoteProjectCreateRequest = z.infer<typeof remoteProjectCreateRequestSchema>;

export const remoteProjectCreateResultSchema = z.object({
  project: projectDirectorySchema,
  created: z.boolean(),
});
export type RemoteProjectCreateResult = z.infer<typeof remoteProjectCreateResultSchema>;

export const remoteProjectForgetRequestSchema = z.object({
  path: z.string().trim().min(1).max(32_768),
}).strict();
export type RemoteProjectForgetRequest = z.infer<typeof remoteProjectForgetRequestSchema>;

export const remoteDirectoryBrowseRequestSchema = z.object({
  path: z.string().trim().max(32_768).optional(),
}).strict();
export type RemoteDirectoryBrowseRequest = z.infer<typeof remoteDirectoryBrowseRequestSchema>;

export const remoteDirectoryBrowseResultSchema = z.object({
  path: z.string().nullable(),
  parentPath: z.string().nullable(),
  directories: z.array(projectDirectorySchema).max(500),
});
export type RemoteDirectoryBrowseResult = z.infer<typeof remoteDirectoryBrowseResultSchema>;

export const remoteThreadStartRequestSchema = z.object({
  projectPath: z.string().min(1).max(32_768),
  model: z.string().min(1).max(500).optional(),
  approvalPolicy: remoteApprovalPolicySchema.optional(),
  sandboxMode: remoteSandboxModeSchema.optional(),
}).strict();
export type RemoteThreadStartRequest = z.infer<typeof remoteThreadStartRequestSchema>;

export const remoteThreadStartResultSchema = z.object({
  threadId: z.string().min(1),
  acceptedAt: z.string().datetime(),
});
export type RemoteThreadStartResult = z.infer<typeof remoteThreadStartResultSchema>;

export const remoteThreadOpenResultSchema = z.object({
  thread: threadSummarySchema,
  timeline: z.array(timelineItemSchema).max(50_000),
});
export type RemoteThreadOpenResult = z.infer<typeof remoteThreadOpenResultSchema>;

export const remoteTurnAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  kind: z.enum(["file", "image"]),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  dataBase64: z.string().min(1).max(35 * 1024 * 1024).refine(
    (value) => value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    "Attachment data must be valid base64.",
  ),
}).strict();
export type RemoteTurnAttachment = z.infer<typeof remoteTurnAttachmentSchema>;

export const remoteTurnStartRequestSchema = z.object({
  text: z.string().max(1_000_000),
  model: z.string().min(1).max(500).optional(),
  approvalPolicy: remoteApprovalPolicySchema.optional(),
  sandboxMode: remoteSandboxModeSchema.optional(),
  reasoningEffort: remoteReasoningEffortSchema.optional(),
  attachments: z.array(remoteTurnAttachmentSchema).max(20).optional(),
}).strict().superRefine((request, context) => {
  if (!request.text.trim() && !request.attachments?.length) {
    context.addIssue({ code: "custom", message: "A turn requires text or an attachment." });
  }
  const totalSize = request.attachments?.reduce((sum, attachment) => sum + attachment.size, 0) || 0;
  if (totalSize > 25 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Attachments can contain at most 25 MB per turn." });
  }
});
export type RemoteTurnStartRequest = z.infer<typeof remoteTurnStartRequestSchema>;

export const remoteTurnStartResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  acceptedAt: z.string().datetime(),
});
export type RemoteTurnStartResult = z.infer<typeof remoteTurnStartResultSchema>;

export const remoteTurnInterruptResultSchema = z.object({
  threadId: z.string().min(1),
  acceptedAt: z.string().datetime(),
});
export type RemoteTurnInterruptResult = z.infer<typeof remoteTurnInterruptResultSchema>;

export const remoteThreadRenameRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();
export type RemoteThreadRenameRequest = z.infer<typeof remoteThreadRenameRequestSchema>;

export const remoteThreadModelRequestSchema = z.object({
  model: z.string().trim().min(1).max(500),
}).strict();
export type RemoteThreadModelRequest = z.infer<typeof remoteThreadModelRequestSchema>;

export const remoteArchivedThreadListRequestSchema = z.object({
  searchTerm: z.string().trim().max(500).optional(),
}).strict();
export type RemoteArchivedThreadListRequest = z.infer<typeof remoteArchivedThreadListRequestSchema>;

export const remoteArchivedThreadListResultSchema = z.object({
  threads: z.array(threadSummarySchema).max(100),
});
export type RemoteArchivedThreadListResult = z.infer<typeof remoteArchivedThreadListResultSchema>;

export const remoteThreadMutationResultSchema = z.object({
  threadId: z.string().min(1),
  acceptedAt: z.string().datetime(),
});
export type RemoteThreadMutationResult = z.infer<typeof remoteThreadMutationResultSchema>;

const remoteUserInputAnswersSchema = z.record(
  z.string().min(1).max(500),
  z.array(z.string().max(100_000)).max(100),
).superRefine((answers, context) => {
  const entries = Object.entries(answers);
  if (entries.length > 100) {
    context.addIssue({ code: "custom", message: "Too many user input answers." });
  }
  let totalCharacters = 0;
  for (const [questionId, values] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(questionId)) {
      context.addIssue({ code: "custom", message: "Reserved user input question ID." });
    }
    totalCharacters += values.reduce((total, value) => total + value.length, 0);
  }
  if (totalCharacters > 1_000_000) {
    context.addIssue({ code: "custom", message: "User input answers are too large." });
  }
});

export const remoteUserInputSubmitRequestSchema = z.object({
  answers: remoteUserInputAnswersSchema,
}).strict();
export type RemoteUserInputSubmitRequest = z.infer<typeof remoteUserInputSubmitRequestSchema>;

export const remoteUserInputSubmitResultSchema = z.object({
  requestId: z.string().min(1),
  acceptedAt: z.string().datetime(),
});
export type RemoteUserInputSubmitResult = z.infer<typeof remoteUserInputSubmitResultSchema>;

export const controlSnapshotSchema = z.object({
  hosts: z.array(hostSummarySchema),
  projects: z.array(projectDirectorySchema).max(500).optional(),
  threads: z.array(threadSummarySchema),
  timeline: z.array(timelineItemSchema),
  approvals: z.array(approvalRequestSchema),
  userInputs: z.array(userInputRequestSchema),
  lastSequence: z.number().int().nonnegative(),
});
export type ControlSnapshot = z.infer<typeof controlSnapshotSchema>;
