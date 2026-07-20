import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import type { ComposerAttachment, PastedImageInput } from "../shared/desktop-api";

const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export function savePastedImage(directory: string, input: unknown): ComposerAttachment {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Pasted image payload must be an object.");
  }

  const candidate = input as Partial<PastedImageInput>;
  const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType.toLowerCase() : "";
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error("Unsupported clipboard image format.");
  if (!(candidate.bytes instanceof Uint8Array)) {
    throw new Error("Pasted image data is invalid.");
  }
  if (candidate.bytes.byteLength === 0) throw new Error("The clipboard image is empty.");
  if (candidate.bytes.byteLength > MAX_PASTED_IMAGE_BYTES) {
    throw new Error("Clipboard images must be 25 MB or smaller.");
  }

  fs.mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `pasted-${Date.now()}-${randomUUID()}.${extension}`);
  fs.writeFileSync(filePath, candidate.bytes);
  return {
    path: filePath,
    name: pastedImageName(candidate.name, extension),
    kind: "image",
    size: candidate.bytes.byteLength,
  };
}

export function removeStalePastedImages(
  directory: string,
  olderThanMs = 7 * 24 * 60 * 60 * 1000,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(directory, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      // A concurrent cleanup or antivirus scan may make a temp file unavailable.
    }
  }
}

function pastedImageName(value: unknown, extension: string): string {
  const requested = typeof value === "string"
    ? value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240)
    : "";
  if (!requested) return `pasted-image.${extension}`;
  return requested.toLowerCase().endsWith(`.${extension}`)
    ? requested
    : `${requested}.${extension}`;
}
