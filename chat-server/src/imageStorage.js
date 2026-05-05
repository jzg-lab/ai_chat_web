import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const generatedImagesDir = path.resolve(__dirname, "../storage/generated-images");
export const generatedImagesPublicPath = "/chat-assets/images";
export const uploadedImagesDir = path.resolve(__dirname, "../storage/uploaded-images");

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

export function detectImageMime(buffer) {
  const extension = detectImageExtension(buffer, "");
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "jpg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  return "";
}

export function isAnimatedGif(buffer) {
  if (detectImageExtension(buffer, "") !== "gif") return false;
  let frames = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
    }
  }
  return false;
}

export async function saveUploadBuffer(buffer, { extension = "png" } = {}) {
  await fs.mkdir(uploadedImagesDir, { recursive: true });
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const filename = `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`;
  const filePath = path.join(uploadedImagesDir, filename);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function saveBase64Image(value) {
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value);
  const contentType = dataUrlMatch?.[1] || "";
  const base64 = dataUrlMatch?.[2] || value;
  const buffer = Buffer.from(base64.replace(/\s/g, ""), "base64");
  const fallback = extensionFromContentType(contentType) || "png";
  return saveImageBuffer(buffer, { extension: detectImageExtension(buffer, fallback) });
}

export async function saveDataUrlUpload(value) {
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value);
  if (!dataUrlMatch) {
    throw new Error("Image data URL is invalid.");
  }
  const contentType = dataUrlMatch[1];
  const buffer = Buffer.from(dataUrlMatch[2].replace(/\s/g, ""), "base64");
  const fallback = extensionFromContentType(contentType) || "png";
  const detected = detectImageExtension(buffer, fallback);
  return {
    path: await saveUploadBuffer(buffer, { extension: detected }),
    mimeType: detectImageMime(buffer) || contentType,
    filename: `upload.${detected || fallback}`
  };
}

export async function downloadAndSaveImage(imageUrl, { timeoutMs = 600000 } = {}) {
  const parsed = new URL(imageUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Upstream returned an unsupported image URL.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Image download failed with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const fallback = extensionFromContentType(contentType) || "png";
    const detected = detectImageExtension(buffer, "");
    if (!detected && contentType && !contentType.toLowerCase().startsWith("image/") && contentType !== "application/octet-stream") {
      throw new Error(`Image download returned non-image content-type: ${contentType}.`);
    }
    return saveImageBuffer(buffer, { extension: detected || fallback });
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadUploadImage(imageUrl, { timeoutMs = 600000 } = {}) {
  const parsed = new URL(imageUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Image URL must use http or https.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Image download failed with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const fallback = extensionFromContentType(contentType) || "png";
    const detected = detectImageExtension(buffer, "");
    if (!detected) {
      throw new Error("Downloaded reference is not a supported image.");
    }
    return {
      path: await saveUploadBuffer(buffer, { extension: detected || fallback }),
      mimeType: detectImageMime(buffer) || contentType || "application/octet-stream",
      filename: path.basename(parsed.pathname) || `upload.${detected || fallback}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteGeneratedImage(publicUrl) {
  let pathname = "";
  try {
    pathname = new URL(publicUrl, "http://local").pathname;
  } catch {
    return false;
  }

  if (!pathname.startsWith(`${generatedImagesPublicPath}/`)) {
    return false;
  }

  const filename = path.basename(decodeURIComponent(pathname));
  const resolvedDir = path.resolve(generatedImagesDir);
  const filePath = path.resolve(generatedImagesDir, filename);
  if (!filePath.startsWith(`${resolvedDir}${path.sep}`)) {
    return false;
  }

  await fs.rm(filePath, { force: true });
  return true;
}

export async function deleteUploadFile(filePath) {
  const resolvedDir = path.resolve(uploadedImagesDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
    return false;
  }
  await fs.rm(resolvedFile, { force: true });
  return true;
}
