import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const generatedImagesDir = path.resolve(__dirname, "../storage/generated-images");
export const generatedImagesPublicPath = "/chat-assets/images";

const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/gif", "gif"]
]);

function extensionFromContentType(contentType = "") {
  const clean = contentType.split(";")[0].trim().toLowerCase();
  return IMAGE_TYPES.get(clean) || "";
}

function detectImageExtension(buffer, fallback = "png") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return "gif";
  }
  return fallback;
}

async function saveImageBuffer(buffer, { extension = "png" } = {}) {
  await fs.mkdir(generatedImagesDir, { recursive: true });
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const filename = `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`;
  const filePath = path.join(generatedImagesDir, filename);
  await fs.writeFile(filePath, buffer);
  return `${generatedImagesPublicPath}/${filename}`;
}

export async function saveBase64Image(value) {
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value);
  const contentType = dataUrlMatch?.[1] || "";
  const base64 = dataUrlMatch?.[2] || value;
  const buffer = Buffer.from(base64.replace(/\s/g, ""), "base64");
  const fallback = extensionFromContentType(contentType) || "png";
  return saveImageBuffer(buffer, { extension: detectImageExtension(buffer, fallback) });
}

export async function downloadAndSaveImage(imageUrl, { timeoutMs = 600000 } = {}) {
  const parsed = new URL(imageUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("上游返回了不支持的图片地址。");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) {
      throw new Error("下载上游图片失败。");
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const fallback = extensionFromContentType(contentType) || "png";
    return saveImageBuffer(buffer, { extension: detectImageExtension(buffer, fallback) });
  } finally {
    clearTimeout(timeout);
  }
}
