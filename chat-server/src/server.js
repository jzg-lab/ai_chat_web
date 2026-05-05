import compression from "compression";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createImageJob, getExternalImageJob, getImageJob, markImageJobDelivered, toExternalImageJob } from "./imageJobs.js";
import {
  deleteUploadFile,
  detectImageMime,
  downloadUploadImage,
  generatedImagesDir,
  isAnimatedGif,
  saveDataUrlUpload,
  uploadedImagesDir
} from "./imageStorage.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const legacyApiBaseUrl = process.env.SUB2API_BASE_URL;
const apiBaseUrl = (process.env.API_BASE_URL || legacyApiBaseUrl || "https://ciyuan.fast/v1").replace(/\/+$/, "");
const imageApiBaseUrl = (process.env.IMAGE_API_BASE_URL || "https://imgapi.ciyuan.fast/v1").replace(/\/+$/, "");
const endpointPrefix = legacyApiBaseUrl && !process.env.API_BASE_URL ? "/v1" : "";
const chatEndpoint = process.env.CHAT_COMPLETIONS_ENDPOINT || `${endpointPrefix}/chat/completions`;
const modelsEndpoint = process.env.MODELS_ENDPOINT || `${endpointPrefix}/models`;
const responsesEndpoint = process.env.RESPONSES_ENDPOINT || `${endpointPrefix}/responses`;
const imageGenerationEndpoint = process.env.IMAGE_ENDPOINT || process.env.IMAGE_GENERATIONS_ENDPOINT || "/images/generations";
const imageEditsEndpoint = process.env.IMAGE_EDITS_ENDPOINT || "/images/edits";
const imageVariationsEndpoint = process.env.IMAGE_VARIATIONS_ENDPOINT || "/images/variations";
const imageModel = process.env.IMAGE_MODEL || "";
function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const upstreamTimeoutMs = positiveNumber(process.env.UPSTREAM_TIMEOUT_MS, 600000);
const imageJobDeliveryCleanupMs = positiveNumber(process.env.IMAGE_JOB_DELIVERY_CLEANUP_MS, 3600000);
const imageUploadTtlMs = positiveNumber(process.env.IMAGE_UPLOAD_TTL_MS, 30 * 60 * 1000);
const imageUploadMaxBytes = positiveNumber(process.env.IMAGE_UPLOAD_MAX_BYTES, 20 * 1024 * 1024);
const imageUploadMaxFiles = positiveNumber(process.env.IMAGE_UPLOAD_MAX_FILES, 16);
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "32mb";
const frameAncestors = (process.env.FRAME_ANCESTORS || "'self' https://ciyuan.fast https://*.ciyuan.fast")
  .split(/\s+/)
  .filter(Boolean);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../../chat-web/dist");
const supportedUploadTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fs.mkdir(uploadedImagesDir, { recursive: true })
        .then(() => callback(null, uploadedImagesDir))
        .catch((error) => callback(error, uploadedImagesDir));
    },
    filename(_req, file, callback) {
      const extension = path.extname(file.originalname || "").replace(/[^.a-z0-9]/gi, "").toLowerCase() || ".png";
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    }
  }),
  fileFilter(_req, file, callback) {
    if (!supportedUploadTypes.has(String(file.mimetype || "").toLowerCase())) {
      callback(new Error("Only PNG, JPEG, WEBP, and non-animated GIF images are supported."));
      return;
    }
    callback(null, true);
  },
  limits: {
    fileSize: imageUploadMaxBytes,
    files: imageUploadMaxFiles + 1
  }
});

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors,
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        upgradeInsecureRequests: null
      }
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: false
  })
);
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith("/chat-api/")) return false;
      return compression.filter(req, res);
    }
  })
);
app.use(express.json({ limit: jsonBodyLimit }));

function joinUrl(origin, endpoint) {
  return `${origin}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function isOpenAIImageModel(value) {
  return String(value || "").toLowerCase().startsWith("gpt-image");
}

function clampImageCount(value, model) {
  const max = String(model || "").toLowerCase() === "dall-e-3" ? 1 : 10;
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 1;
  return Math.min(Math.max(number, 1), max);
}

function imageGenerationBody(body) {
  const next = { ...body };
  if (imageModel && !next.model) {
    next.model = imageModel;
  }
  next.n = clampImageCount(next.n, next.model);
  if (!next.response_format || (isOpenAIImageModel(next.model) && next.response_format === "url")) {
    next.response_format = "b64_json";
  }
  return next;
}

function imageEditBody(body) {
  const next = { ...body };
  delete next.images;
  if (imageModel && !next.model) {
    next.model = imageModel;
  }
  next.n = clampImageCount(next.n, next.model);
  if (!next.response_format || (isOpenAIImageModel(next.model) && next.response_format === "url")) {
    next.response_format = "b64_json";
  }
  return next;
}

function requestOrigin(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${proto}://${host}` : "";
}

function absoluteUrl(req, value) {
  if (!value || /^https?:\/\//i.test(value) || value.startsWith("data:")) {
    return value;
  }
  const origin = requestOrigin(req);
  return origin ? `${origin}${value.startsWith("/") ? value : `/${value}`}` : value;
}

function withAbsoluteImageUrls(req, payload) {
  if (payload?.result?.data) {
    payload.result.data = payload.result.data.map((item) => (item.url ? { ...item, url: absoluteUrl(req, item.url) } : item));
  }
  return payload;
}

function publicHeaders(headers) {
  const next = {};
  const allow = ["content-type", "cache-control"];
  for (const name of allow) {
    const value = headers.get(name);
    if (value) next[name] = value;
  }
  return next;
}

function getAuthorization(req) {
  const authorization = req.get("authorization");
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  let token = authorization.replace(/^bearer\s+/i, "").trim();
  while (token.toLowerCase().startsWith("bearer ")) {
    token = token.replace(/^bearer\s+/i, "").trim();
  }
  return token ? `Bearer ${token}` : "";
}

function uploadImageFields(req, res, next) {
  upload.fields([
    { name: "image", maxCount: imageUploadMaxFiles },
    { name: "image[]", maxCount: imageUploadMaxFiles },
    { name: "mask", maxCount: 1 }
  ])(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    const status = error instanceof multer.MulterError ? 400 : 500;
    res.status(status).json({ error: { message: error.message || "Image upload failed." } });
  });
}

function uploadedFiles(req) {
  const files = req.files || {};
  return [...(files.image || []), ...(files["image[]"] || [])];
}

function uploadedMask(req) {
  return (req.files?.mask || [])[0] || null;
}

function scheduleUploadCleanup(files) {
  for (const file of files) {
    const timer = setTimeout(() => {
      deleteUploadFile(file.path).catch(() => {});
    }, imageUploadTtlMs);
    timer.unref?.();
  }
}

async function validateUploadFiles(files) {
  if (files.length > imageUploadMaxFiles) {
    throw new Error(`Upload at most ${imageUploadMaxFiles} reference images.`);
  }
  for (const file of files) {
    const buffer = await fs.readFile(file.path);
    const detected = detectImageMime(buffer);
    if (!supportedUploadTypes.has(detected)) {
      throw new Error("Only PNG, JPEG, WEBP, and non-animated GIF images are supported.");
    }
    if (isAnimatedGif(buffer)) {
      throw new Error("Animated GIF images are not supported.");
    }
    file.mimetype = detected || file.mimetype;
  }
}

function toJobFile(file, fieldName = file.fieldname) {
  return {
    fieldName,
    path: file.path,
    filename: file.originalname || path.basename(file.path),
    mimeType: file.mimetype || "application/octet-stream"
  };
}

async function cleanupUploads(files) {
  for (const file of files) {
    await deleteUploadFile(file.path).catch(() => {});
  }
}

function isMultipart(req) {
  return (req.get("content-type") || "").toLowerCase().startsWith("multipart/form-data");
}

async function jsonReferenceFiles(body) {
  const references = Array.isArray(body.images) ? body.images : [];
  if (references.length > imageUploadMaxFiles) {
    throw new Error(`Upload at most ${imageUploadMaxFiles} reference images.`);
  }

  const files = [];
  const imageIds = [];
  for (const item of references) {
    const imageUrl = typeof item === "string" ? item : item?.image_url || item?.url;
    const fileId = typeof item === "object" ? item?.file_id : "";
    if (imageUrl?.startsWith("data:image/")) {
      files.push({ ...(await saveDataUrlUpload(imageUrl)), fieldName: "image[]" });
      continue;
    }
    if (/^https?:\/\//i.test(imageUrl || "")) {
      files.push({ ...(await downloadUploadImage(imageUrl, { timeoutMs: upstreamTimeoutMs })), fieldName: "image[]" });
      continue;
    }
    if (fileId) {
      imageIds.push(fileId);
      continue;
    }
    throw new Error("Each image reference must include image_url, url, or file_id.");
  }

  return { files, imageIds };
}

function createJobResponse(res, job, external = false) {
  res.status(202).json(external ? toExternalImageJob(job) : job);
}

async function forwardUpstream(req, res, origin, endpoint, { method = "POST", body } = {}) {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "请先填写 API Key。" } });
    return;
  }

  let upstream;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, upstreamTimeoutMs);
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    upstream = await fetch(joinUrl(origin, endpoint), {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: authorization
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
  } catch {
    clearTimeout(timeout);
    if (res.destroyed || res.writableEnded) return;
    if (timedOut) {
      res.status(504).json({ error: { message: "上游接口响应超时。" } });
      return;
    }
    res.status(502).json({ error: { message: "无法连接上游接口。" } });
    return;
  }

  if (res.destroyed) {
    clearTimeout(timeout);
    controller.abort();
    return;
  }

  res.status(upstream.status);
  for (const [name, value] of Object.entries(publicHeaders(upstream.headers))) {
    res.setHeader(name, value);
  }

  if (!upstream.body) {
    clearTimeout(timeout);
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    controller.abort();
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardJson(req, res, origin, endpoint, body) {
  await forwardUpstream(req, res, origin, endpoint, { method: "POST", body });
}

app.get("/chat-api/models", async (req, res) => {
  await forwardUpstream(req, res, apiBaseUrl, modelsEndpoint, { method: "GET" });
});

app.post("/chat-api/chat/completions", async (req, res) => {
  await forwardJson(req, res, apiBaseUrl, chatEndpoint, req.body);
});

app.post("/chat-api/responses", async (req, res) => {
  await forwardJson(req, res, apiBaseUrl, responsesEndpoint, req.body);
});

async function forwardImage(req, res, endpoint) {
  const body = { ...req.body };
  if (imageModel && !body.model) {
    body.model = imageModel;
  }
  await forwardJson(req, res, imageApiBaseUrl, endpoint, body);
}

app.post("/chat-api/images/generations", async (req, res) => {
  await forwardImage(req, res, imageGenerationEndpoint);
});

app.post(
  "/chat-api/image-jobs",
  (req, res, next) => {
    if (isMultipart(req)) {
      uploadImageFields(req, res, next);
      return;
    }
    next();
  },
  async (req, res) => {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "请先填写 API Key。" } });
    return;
  }

  const images = uploadedFiles(req);
  const mask = uploadedMask(req);
  const allUploads = [...images, ...(mask ? [mask] : [])];
  scheduleUploadCleanup(allUploads);
  try {
    await validateUploadFiles(allUploads);
  } catch (error) {
    await cleanupUploads(allUploads);
    res.status(400).json({ error: { message: error?.message || "Invalid image upload." } });
    return;
  }

  if (images.length) {
    const files = images.map((file) => toJobFile(file));
    if (mask) files.push(toJobFile(mask, "mask"));
    const job = createImageJob(imageEditBody(req.body), authorization, {
      operation: "edit",
      requestType: "multipart",
      files,
      upstreamUrl: joinUrl(imageApiBaseUrl, imageEditsEndpoint),
      upstreamTimeoutMs
    });

    createJobResponse(res, job);
    return;
  }

  const body = imageGenerationBody(req.body);

  const job = createImageJob(body, authorization, {
    operation: "generation",
    upstreamUrl: joinUrl(imageApiBaseUrl, imageGenerationEndpoint),
    upstreamTimeoutMs
  });

  createJobResponse(res, job);
  }
);

app.post("/v1/images/generations", (req, res) => {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "Missing Authorization bearer token." } });
    return;
  }

  const job = createImageJob(imageGenerationBody(req.body), authorization, {
    operation: "generation",
    upstreamUrl: joinUrl(imageApiBaseUrl, imageGenerationEndpoint),
    upstreamTimeoutMs
  });

  createJobResponse(res, job, true);
});

app.post(
  "/v1/images/edits",
  (req, res, next) => {
    if (isMultipart(req)) {
      uploadImageFields(req, res, next);
      return;
    }
    next();
  },
  async (req, res) => {
    const authorization = getAuthorization(req);
    if (!authorization) {
      res.status(401).json({ error: { message: "Missing Authorization bearer token." } });
      return;
    }

    let body = imageEditBody(req.body);
    let files = [];
    const images = uploadedFiles(req);
    const mask = uploadedMask(req);
    const allUploads = [...images, ...(mask ? [mask] : [])];
    scheduleUploadCleanup(allUploads);

    try {
      if (isMultipart(req)) {
        await validateUploadFiles(allUploads);
        if (!images.length) {
          throw new Error("At least one image is required.");
        }
        files = images.map((file) => toJobFile(file));
        if (mask) files.push(toJobFile(mask, "mask"));
      } else {
        const referenced = await jsonReferenceFiles(req.body || {});
        await validateUploadFiles(referenced.files);
        files = referenced.files.map((file) => ({
          fieldName: file.fieldName,
          path: file.path,
          filename: file.filename,
          mimeType: file.mimeType || file.mimetype
        }));
        if (referenced.imageIds.length) {
          body = { ...body, "image[]": referenced.imageIds };
        }
        if (!files.length && !referenced.imageIds.length) {
          throw new Error("At least one image reference is required.");
        }
        scheduleUploadCleanup(files);
      }
    } catch (error) {
      await cleanupUploads([...allUploads, ...files]);
      res.status(400).json({ error: { message: error?.message || "Invalid image edit request." } });
      return;
    }

    const job = createImageJob(body, authorization, {
      operation: "edit",
      requestType: "multipart",
      files,
      upstreamUrl: joinUrl(imageApiBaseUrl, imageEditsEndpoint),
      upstreamTimeoutMs
    });

    createJobResponse(res, job, true);
  }
);

app.get("/chat-api/image-jobs/:jobId", (req, res) => {
  const job = getImageJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: { message: "生图任务不存在或已过期。" } });
    return;
  }

  res.json(job);
  if (job.status === "succeeded") {
    markImageJobDelivered(req.params.jobId, imageJobDeliveryCleanupMs);
  }
});

app.get("/v1/image-jobs/:jobId", (req, res) => {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "Missing Authorization bearer token." } });
    return;
  }

  const job = getExternalImageJob(req.params.jobId, authorization);
  if (!job) {
    res.status(404).json({ error: { message: "Image job not found." } });
    return;
  }

  res.json(withAbsoluteImageUrls(req, job));
  if (job.status === "succeeded") {
    markImageJobDelivered(req.params.jobId, imageJobDeliveryCleanupMs);
  }
});

app.post("/chat-api/images/edits", async (req, res) => {
  await forwardImage(req, res, imageEditsEndpoint);
});

app.post("/chat-api/images/variations", async (req, res) => {
  await forwardImage(req, res, imageVariationsEndpoint);
});

app.get("/chat-api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/chat-assets/images", express.static(generatedImagesDir, { index: false, immutable: true, maxAge: "30m" }));

app.use("/chat", express.static(webDist, { index: false }));
app.get(["/chat", "/chat/*"], (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

app.get("/", (_req, res) => {
  res.redirect(302, "/chat");
});

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(err?.type === "entity.too.large" ? 413 : 500).json({
    error: { message: err?.type === "entity.too.large" ? "请求体过大。" : "服务内部错误。" }
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`ciyuan-chat listening on ${port}`);
});
