import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RemoteTurnAttachment } from "@rhzycode/protocol";
import type { ComposerAttachment } from "../shared/desktop-api";

export function saveRemoteAttachments(
  directory: string,
  attachments: RemoteTurnAttachment[],
): ComposerAttachment[] {
  if (!attachments.length) return [];
  const validated = attachments.map((attachment) => {
    const bytes = Buffer.from(attachment.dataBase64, "base64");
    if (bytes.byteLength !== attachment.size) throw new Error("Remote attachment size is invalid.");
    return { attachment, bytes, name: safeName(attachment.name) };
  });
  fs.mkdirSync(directory, { recursive: true });
  return validated.map(({ attachment, bytes, name }) => {
    const filePath = path.join(directory, `${Date.now()}-${randomUUID()}-${name}`);
    fs.writeFileSync(filePath, bytes, { flag: "wx" });
    return { path: filePath, name, kind: attachment.kind, size: bytes.byteLength };
  });
}

function safeName(value: string): string {
  const name = value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
  return name || "attachment";
}
