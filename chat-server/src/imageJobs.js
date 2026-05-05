import crypto from "node:crypto";
import fs from "node:fs/promises";
import { deleteGeneratedImage, deleteUploadFile, downloadAndSaveImage, saveBase64Image } from "./imageStorage.js";

const JOB_TTL_MS = 30 * 60 * 1000;
const BODY_PREVIEW_LIMIT = 300;
const ownerHashSecret = process.env.IMAGE_JOB_OWNER_SECRET || crypto.randomBytes(32).toString("hex");
const jobs = new Map();

function publicJob(job) {
  const payload = {
    job_id: job.id,
    operation: job.operation,
    status: job.status,
    error: job.error || "",
    upstream_status: job.upstreamStatus ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };

  if (job.upstreamBodyPreview) {
    payload.upstream_body_preview = job.upstreamBodyPreview;
  }
  if (job.warnings?.length) {
    payload.warnings = job.warnings;
  }
  if (job.status === "succeeded") {
    payload.images = job.images;
  }

  return payload;
}

function externalJob(job) {
  const payload = {
    id: job.id,
    object: job.operation === "edit" ? "image_edit.job" : "image_generation.job",
    status: job.status,
    created: Math.floor(job.createdAt / 1000),
    poll_url: `/v1/image-jobs/${job.id}`
  };

  if (job.status === "succeeded") {
    const completedAt = job.completedAt || job.updatedAt;
    payload.completed_at = Math.floor(completedAt / 1000);
    payload.result = {
      created: Math.floor(completedAt / 1000),
      data: job.images.map((url) => ({ url }))
    };
  }
  if (job.status === "failed") {
    payload.error = {
      message: job.error || "Image job failed."
    };
  }

  return payload;
}

function logJob(job, message, extra = {}) {
  console.log(`[image-job] ${message}`, {
    job_id: job.id,
    ...extra
  });
}

function warnJob(job, message, extra = {}) {
  console.warn(`[image-job] ${message}`, {
    job_id: job.id,
    ...extra
  });
}

function timeoutMessage(timeoutMs) {
  if (timeoutMs < 60000) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return `Upstream image request timed out after ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  return `Upstream image request timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function authorizationDebug(authorization) {
  const value = typeof authorization === "string" ? authorization.trim() : "";
  const startsWithBearer = value.toLowerCase().startsWith("bearer ");
  const token = startsWithBearer ? value.replace(/^bearer\s+/i, "").trim() : value;
  return {
    has_authorization: Boolean(value),
    authorization_starts_with_bearer: startsWithBearer,
    authorization_preview: token ? `${token.slice(0, 6)}...${token.slice(-4)}` : ""
  };
}

function ownerHash(authorization) {
  return crypto.createHmac("sha256", ownerHashSecret).update(authorization).digest("hex");
}

function ownerMatches(job, authorization) {
  if (!job.ownerHash || !authorization) return false;
  const expected = Buffer.from(job.ownerHash, "hex");
  const actual = Buffer.from(ownerHash(authorization), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function cleanupJob(job) {
  for (const image of job.images || []) {
    try {
      const deleted = await deleteGeneratedImage(image);
      if (deleted) {
        logJob(job, "deleted generated image", { image_url: image });
      }
    } catch (error) {
      warnJob(job, "generated image cleanup failed", { image_url: image, error: error?.message || "unknown error" });
    }
  }
  for (const file of job.files || []) {
    try {
      await deleteUploadFile(file.path);
    } catch {
      // Temp upload cleanup is best-effort; generated image cleanup is the user-visible part.
    }
  }
  jobs.delete(job.id);
}

function scheduleCleanup(job, delayMs = JOB_TTL_MS) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    cleanupJob(job);
  }, delayMs);
  job.cleanupTimer.unref?.();
}

function failMessage(status, payload) {
  if (payload && typeof payload === "object") {
    const body = payload;
    return body.error?.message || body.message || `Upstream request failed ${status}`;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim().slice(0, BODY_PREVIEW_LIMIT);
  }
  return `Upstream request failed ${status}`;
}

function readUpstreamMessage(status, text) {
  try {
    return failMessage(status, JSON.parse(text));
  } catch {
    return failMessage(status, text);
  }
}

function extractImages(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => ({
      b64_json: typeof item?.b64_json === "string" ? item.b64_json : "",
      url: typeof item?.url === "string" ? item.url : ""
    }))
    .filter((item) => item.b64_json || item.url);
}

async function persistImage(item, timeoutMs) {
  if (item.b64_json) {
    return { url: await saveBase64Image(item.b64_json) };
  }
  if (item.url.startsWith("data:image/")) {
    return { url: await saveBase64Image(item.url) };
  }

  try {
    return { url: await downloadAndSaveImage(item.url, { timeoutMs }) };
  } catch (error) {
    return {
      url: item.url,
      warning: `Image download failed, returned upstream URL fallback: ${error?.message || "unknown error"}`
    };
  }
}

function previewBody(body, requestType) {
  if (requestType !== "multipart") return JSON.stringify(body).slice(0, BODY_PREVIEW_LIMIT);
  const safe = Object.fromEntries(Object.entries(body || {}).map(([key, value]) => [key, String(value).slice(0, 80)]));
  return JSON.stringify({ ...safe, image: "[uploaded image files]" }).slice(0, BODY_PREVIEW_LIMIT);
}

async function createMultipartBody(body, files) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        form.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
      continue;
    }
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }

  for (const file of files || []) {
    const buffer = await fs.readFile(file.path);
    const blob = new Blob([buffer], { type: file.mimeType || "application/octet-stream" });
    form.append(file.fieldName || "image[]", blob, file.filename || "image.png");
  }
  return form;
}

async function runImageJob(job, options) {
  job.status = "running";
  job.updatedAt = Date.now();
  logJob(job, "started", { operation: job.operation, upstream_url: options.upstreamUrl, ...authorizationDebug(job.authorization) });

  const controller = new AbortController();
  let completed = false;
  let cleaned = false;

  const failJob = (message) => {
    if (completed) return false;
    completed = true;
    job.status = "failed";
    job.error = message;
    job.updatedAt = Date.now();
    return true;
  };

  const succeedJob = (images) => {
    if (completed) return false;
    completed = true;
    job.status = "succeeded";
    job.images = images;
    job.completedAt = Date.now();
    job.updatedAt = Date.now();
    return true;
  };

  const cleanupJobData = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const file of job.files || []) {
      try {
        await deleteUploadFile(file.path);
      } catch (error) {
        warnJob(job, "upload cleanup failed", { file: file.filename, error: error?.message || "unknown error" });
      }
    }
    delete job.authorization;
    delete job.body;
    delete job.files;
    scheduleCleanup(job);
  };

  const timeout = setTimeout(() => {
    controller.abort();
    if (failJob(timeoutMessage(options.upstreamTimeoutMs))) {
      warnJob(job, "timed out", {
        upstream_url: options.upstreamUrl,
        upstream_status: job.upstreamStatus ?? null,
        upstream_body_preview: job.upstreamBodyPreview || "",
        error: job.error
      });
      cleanupJobData().catch((error) => {
        warnJob(job, "timeout cleanup failed", { error: error?.message || "unknown error" });
      });
    }
  }, options.upstreamTimeoutMs);
  timeout.unref?.();

  try {
    const isMultipart = options.requestType === "multipart";
    const requestBody = isMultipart ? await createMultipartBody(job.body, job.files) : JSON.stringify(job.body);
    const upstream = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: {
        ...(isMultipart ? {} : { "Content-Type": "application/json" }),
        Authorization: job.authorization
      },
      body: requestBody,
      signal: controller.signal
    });

    job.upstreamStatus = upstream.status;
    logJob(job, "upstream responded", { upstream_url: options.upstreamUrl, upstream_status: upstream.status });

    const upstreamText = await upstream.text();
    job.upstreamBodyPreview = upstreamText.slice(0, BODY_PREVIEW_LIMIT);
    if (!upstream.ok) {
      const message = `Upstream ${upstream.status}: ${readUpstreamMessage(upstream.status, upstreamText)}`;
      warnJob(job, "upstream failed", {
        upstream_url: options.upstreamUrl,
        upstream_status: upstream.status,
        upstream_body_preview: job.upstreamBodyPreview,
        error: message
      });
      throw new Error(message);
    }

    let payload;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      throw new Error(`Upstream ${upstream.status}: invalid JSON response`);
    }

    const imageItems = extractImages(payload);
    if (!imageItems.length) {
      throw new Error(`Upstream ${upstream.status}: image response did not include url or b64_json`);
    }

    const images = [];
    for (const item of imageItems) {
      const saved = await persistImage(item, options.upstreamTimeoutMs);
      images.push(saved.url);
      if (saved.warning) {
        job.warnings.push(saved.warning);
        warnJob(job, "image persistence warning", { error: saved.warning });
      }
    }

    if (succeedJob(images)) {
      logJob(job, "succeeded", { image_count: images.length, warnings: job.warnings.length });
    }
  } catch (error) {
    const message = error?.name === "AbortError" ? timeoutMessage(options.upstreamTimeoutMs) : error?.message || "Image job failed.";
    if (failJob(message)) {
      warnJob(job, "failed", {
        upstream_url: options.upstreamUrl,
        upstream_status: job.upstreamStatus ?? null,
        upstream_body_preview: job.upstreamBodyPreview || "",
        error: job.error
      });
    }
  } finally {
    clearTimeout(timeout);
    await cleanupJobData();
  }
}

export function createImageJob(body, authorization, options) {
  const job = {
    id: `imgjob_${crypto.randomUUID().replace(/-/g, "")}`,
    operation: options.operation || "generation",
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    body,
    files: options.files || [],
    authorization,
    ownerHash: ownerHash(authorization),
    images: [],
    error: "",
    upstreamStatus: null,
    upstreamBodyPreview: "",
    warnings: []
  };
  job.upstreamBodyPreview = previewBody(body, options.requestType);

  jobs.set(job.id, job);
  logJob(job, "queued", { operation: job.operation, upstream_url: options.upstreamUrl, ...authorizationDebug(job.authorization) });
  setImmediate(() => {
    runImageJob(job, options);
  });

  return publicJob(job);
}

export function getImageJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

export function getExternalImageJob(jobId, authorization) {
  const job = jobs.get(jobId);
  if (!job || !ownerMatches(job, authorization)) {
    return null;
  }
  return externalJob(job);
}

export function toExternalImageJob(job) {
  return {
    id: job.job_id,
    object: job.operation === "edit" ? "image_edit.job" : "image_generation.job",
    status: job.status,
    created: Math.floor(job.created_at / 1000),
    poll_url: `/v1/image-jobs/${job.job_id}`
  };
}

export function markImageJobDelivered(jobId, cleanupDelayMs) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "succeeded" || job.deliveredAt) {
    return;
  }

  job.deliveredAt = Date.now();
  logJob(job, "delivered, cleanup scheduled", { cleanup_delay_ms: cleanupDelayMs });
  scheduleCleanup(job, cleanupDelayMs);
}
