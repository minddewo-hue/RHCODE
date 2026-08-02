import type { ApprovalRequest } from "@rhzycode/protocol";
import { turnScopedItemId } from "../shared/item-identity";

export type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

export interface PendingApproval {
  rpcId: number | string;
  method: ApprovalMethod;
  threadId: string;
  permissions?: Record<string, unknown>;
}

export function isApprovalRequest(method: string): method is ApprovalMethod {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval";
}

export function createApprovalRequest(input: {
  rpcId: number | string;
  method: ApprovalMethod;
  params: Record<string, unknown>;
  threadId: string;
  turnId: string | null;
  itemDetails: ReadonlyMap<string, string>;
  createdAt?: string;
}): { id: string; pending: PendingApproval; approval: ApprovalRequest } {
  const id = `approval-${String(input.rpcId)}`;
  const isPermission = input.method === "item/permissions/requestApproval";
  const isFileChange = input.method === "item/fileChange/requestApproval";
  const permissions = isPermission
    ? ((input.params.permissions || {}) as Record<string, unknown>)
    : undefined;
  return {
    id,
    pending: {
      rpcId: input.rpcId,
      method: input.method,
      threadId: input.threadId,
      permissions,
    },
    approval: {
      id,
      threadId: input.threadId,
      kind: isPermission ? "permission" : isFileChange ? "file_change" : "command",
      title: isPermission ? "批准额外权限" : isFileChange ? "批准文件修改" : "批准命令执行",
      detail: isPermission
        ? describePermissions(input.params)
        : describeApproval(input.params, input.itemDetails, input.turnId),
      createdAt: input.createdAt || new Date().toISOString(),
    },
  };
}

export function approvalResponse(
  pending: PendingApproval,
  decision: "approved" | "declined",
): Record<string, unknown> {
  if (pending.method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "approved" ? grantedPermissions(pending.permissions) : {},
      scope: "turn",
    };
  }
  return { decision: decision === "approved" ? "accept" : "decline" };
}

function describeApproval(
  params: Record<string, unknown>,
  itemDetails: ReadonlyMap<string, string>,
  turnId: string | null,
): string {
  const itemId = String(params.itemId || params.callId || "");
  const itemDetail = itemId ? itemDetails.get(turnScopedItemId(turnId, itemId)) : null;
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  return limitDetail(String(
    command
      || itemDetail
      || params.reason
      || params.cwd
      || "Agent 请求继续执行",
  ));
}

function describePermissions(params: Record<string, unknown>): string {
  const permissions = (params.permissions || {}) as Record<string, unknown>;
  const network = permissions.network as Record<string, unknown> | null | undefined;
  const fileSystem = permissions.fileSystem as Record<string, unknown> | null | undefined;
  const details: unknown[] = [params.reason, params.cwd];
  if (network?.enabled) details.push("Network access");
  if (fileSystem) {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read : [];
    const write = Array.isArray(fileSystem.write) ? fileSystem.write : [];
    if (read.length) details.push(`Read: ${read.join(", ")}`);
    if (write.length) details.push(`Write: ${write.join(", ")}`);
    if (Array.isArray(fileSystem.entries) && fileSystem.entries.length) {
      details.push(`Additional filesystem entries: ${fileSystem.entries.length}`);
    }
  }
  return limitDetail(details.filter(Boolean).map(String).join("\n") || "Agent requested additional permissions");
}

function grantedPermissions(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const granted: Record<string, unknown> = {};
  if (value.network && typeof value.network === "object") granted.network = value.network;
  if (value.fileSystem && typeof value.fileSystem === "object") granted.fileSystem = value.fileSystem;
  return granted;
}

function limitDetail(detail: string): string {
  const maxLength = 12_000;
  return detail.length > maxLength ? `${detail.slice(0, maxLength)}\n...` : detail;
}
