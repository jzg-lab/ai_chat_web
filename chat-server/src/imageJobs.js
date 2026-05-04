import crypto from "node:crypto";
import { deleteGeneratedImage, downloadAndSaveImage, saveBase64Image } from "./imageStorage.js";

const JOB_TTL_MS = 30 * 60 * 1000;
const BODY_PREVIEW_LIMIT = 300;
const jobs = new Map();

function publicJob(job) {
  const payload = {
    job_id: job.id,
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

async function runImageJob(job, options) {
  job.status = "running";
  job.updatedAt = Date.now();
  logJob(job, "started", { upstream_url: options.upstreamUrl, ...authorizationDebug(job.authorization) });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.upstreamTimeoutMs);

  try {
    const upstream = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: job.authorization
      },
      body: JSON.stringify(job.body),
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

    job.status = "succeeded";
    job.images = images;
    job.updatedAt = Date.now();
    logJob(job, "succeeded", { image_count: images.length, warnings: job.warnings.length });
  } catch (error) {
    job.status = "failed";
    job.error = error?.name === "AbortError" ? "Upstream image request timed out." : error?.message || "Image job failed.";
    job.updatedAt = Date.now();
    warnJob(job, "failed", {
      upstream_url: options.upstreamUrl,
      upstream_status: job.upstreamStatus ?? null,
      upstream_body_preview: job.upstreamBodyPreview || "",
      error: job.error
    });
  } finally {
    clearTimeout(timeout);
    delete job.authorization;
    delete job.body;
    scheduleCleanup(job);
  }
}

export function createImageJob(body, authorization, options) {
  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    body,
    authorization,
    images: [],
    error: "",
    upstreamStatus: null,
    upstreamBodyPreview: "",
    warnings: []
  };

  jobs.set(job.id, job);
  logJob(job, "queued", { upstream_url: options.upstreamUrl, ...authorizationDebug(job.authorization) });
  setImmediate(() => {
    runImageJob(job, options);
  });

  return publicJob(job);
}

export function getImageJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
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
