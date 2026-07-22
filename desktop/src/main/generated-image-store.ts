import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const GENERATED_IMAGE_NAME = /^generated-[a-zA-Z0-9_-]+-[a-f0-9]{16}\.(?:gif|jpg|png|webp)$/;

export interface StoredGeneratedImage {
  path: string;
  name: string;
  generated: true;
}

export interface GeneratedImageFile {
  bytes: Buffer;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
}

interface ImageFormat {
  extension: "gif" | "jpg" | "png" | "webp";
}

export function materializeGeneratedImage(
  directory: string,
  item: Record<string, unknown>,
): StoredGeneratedImage | null {
  const savedPath = String(item.savedPath || "").trim();
  if (savedPath) {
    const stored = existingImage(savedPath);
    if (stored) {
      try {
        return storeGeneratedImage(directory, item, fs.readFileSync(stored.path));
      } catch {
        return null;
      }
    }
  }

  const bytes = decodeImageResult(item.result);
  if (!bytes) return null;
  return storeGeneratedImage(directory, item, bytes);
}

function storeGeneratedImage(
  directory: string,
  item: Record<string, unknown>,
  bytes: Buffer,
): StoredGeneratedImage | null {
  const format = detectImageFormat(bytes);
  if (!format) return null;

  fs.mkdirSync(directory, { recursive: true });
  const itemId = String(item.id || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `generated-${itemId || "image"}-${digest}.${format.extension}`;
  const imagePath = path.join(directory, name);

  if (!existingImage(imagePath)) writeImageAtomically(imagePath, bytes);
  return existingImage(imagePath);
}

export function readGeneratedImageFile(directory: string, name: string): GeneratedImageFile | null {
  if (!GENERATED_IMAGE_NAME.test(name) || path.basename(name) !== name) return null;
  const imagePath = path.join(directory, name);
  try {
    const stats = fs.lstatSync(imagePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const stored = existingImage(imagePath);
  if (!stored || stored.name !== name) return null;
  try {
    const bytes = fs.readFileSync(imagePath);
    const format = detectImageFormat(bytes);
    if (!format || `.${format.extension}` !== path.extname(name).toLowerCase()) return null;
    const mimeType = format.extension === "jpg"
      ? "image/jpeg"
      : `image/${format.extension}` as GeneratedImageFile["mimeType"];
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

function existingImage(imagePath: string): StoredGeneratedImage | null {
  if (!path.isAbsolute(imagePath)) return null;
  try {
    const stats = fs.statSync(imagePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_GENERATED_IMAGE_BYTES) return null;
    const descriptor = fs.openSync(imagePath, "r");
    try {
      const signature = Buffer.alloc(Math.min(12, stats.size));
      fs.readSync(descriptor, signature, 0, signature.length, 0);
      if (!detectImageFormat(signature)) return null;
    } finally {
      fs.closeSync(descriptor);
    }
    return {
      path: imagePath,
      name: path.basename(imagePath) || "generated-image",
      generated: true,
    };
  } catch {
    return null;
  }
}

function decodeImageResult(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const dataUrlMatch = value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/s);
  const base64 = (dataUrlMatch?.[1] || value).replace(/\s+/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64)) return null;
  if (base64.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) return null;
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length <= 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) return null;
    return bytes.toString("base64") === base64 ? bytes : null;
  } catch {
    return null;
  }
}

function detectImageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg" };
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { extension: "gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp" };
  }
  return null;
}

function writeImageAtomically(imagePath: string, bytes: Buffer): void {
  const temporaryPath = path.join(
    path.dirname(imagePath),
    `.${path.basename(imagePath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    try {
      fs.renameSync(temporaryPath, imagePath);
    } catch (error) {
      if (!fs.existsSync(imagePath)) throw error;
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename succeeded or the temporary file was never created.
    }
  }
}
