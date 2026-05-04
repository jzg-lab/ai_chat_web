import crypto from "node:crypto";
import { downloadAndSaveImage, saveBase64Image } from "./imageStorage.js";

const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

function publicJob(job) {
  const payload = {
    job_id: job.id,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };

  if (job.status === "succeeded") {
    payload.images = job.images;
  }
  if (job.status === "failed") {
    payload.error = job.error || "生图任务失败。";
  }

  return payload;
}

function scheduleCleanup(job) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    jobs.delete(job.id);
  }, JOB_TTL_MS);
  job.cleanupTimer.unref?.();
}

function failMessage(status, payload) {
  if (payload && typeof payload === "object") {
    const body = payload;
    return body.error?.message || body.message || `上游生图接口请求失败 ${status}`;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim().slice(0, 500);
  }
  return `上游生图接口请求失败 ${status}`;
}

async function readUpstreamError(response) {
  const text = await response.text();
  try {
    return failMessage(response.status, JSON.parse(text));
  } catch {
    return failMessage(response.status, text);
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
    return saveBase64Image(item.b64_json);
  }
  if (item.url.startsWith("data:image/")) {
    return saveBase64Image(item.url);
  }
  return downloadAndSaveImage(item.url, { timeoutMs });
}

async function runImageJob(job, options) {
  job.status = "running";
  job.updatedAt = Date.now();

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

    if (!upstream.ok) {
      throw new Error(await readUpstreamError(upstream));
    }

    const payload = await upstream.json();
    const imageItems = extractImages(payload);
    if (!imageItems.length) {
      throw new Error("生图接口未返回可保存的图片。");
    }

    const images = [];
    for (const item of imageItems) {
      images.push(await persistImage(item, options.upstreamTimeoutMs));
    }

    job.status = "succeeded";
    job.images = images;
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = "failed";
    job.error = error?.name === "AbortError" ? "上游生图接口响应超时。" : error?.message || "生图任务失败。";
    job.updatedAt = Date.now();
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
    error: ""
  };

  jobs.set(job.id, job);
  setImmediate(() => {
    runImageJob(job, options);
  });

  return publicJob(job);
}

export function getImageJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}
