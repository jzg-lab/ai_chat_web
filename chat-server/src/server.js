import compression from "compression";
import express from "express";
import helmet from "helmet";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createImageJob, getExternalImageJob, getImageJob, markImageJobDelivered, toExternalImageJob } from "./imageJobs.js";
import { generatedImagesDir } from "./imageStorage.js";

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
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);
const imageJobDeliveryCleanupMs = Number(process.env.IMAGE_JOB_DELIVERY_CLEANUP_MS || 120000);
const frameAncestors = (process.env.FRAME_ANCESTORS || "'self' https://ciyuan.fast https://*.ciyuan.fast")
  .split(/\s+/)
  .filter(Boolean);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../../chat-web/dist");

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
app.use(express.json({ limit: "8mb" }));

function joinUrl(origin, endpoint) {
  return `${origin}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function isOpenAIImageModel(value) {
  return String(value || "").toLowerCase().startsWith("gpt-image");
}

function imageGenerationBody(body) {
  const next = { ...body };
  if (imageModel && !next.model) {
    next.model = imageModel;
  }
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

app.post("/chat-api/image-jobs", (req, res) => {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "请先填写 API Key。" } });
    return;
  }

  const body = imageGenerationBody(req.body);

  const job = createImageJob(body, authorization, {
    upstreamUrl: joinUrl(imageApiBaseUrl, imageGenerationEndpoint),
    upstreamTimeoutMs
  });

  res.status(202).json(job);
});

app.post("/v1/images/generations", (req, res) => {
  const authorization = getAuthorization(req);
  if (!authorization) {
    res.status(401).json({ error: { message: "Missing Authorization bearer token." } });
    return;
  }

  const job = createImageJob(imageGenerationBody(req.body), authorization, {
    upstreamUrl: joinUrl(imageApiBaseUrl, imageGenerationEndpoint),
    upstreamTimeoutMs
  });

  res.status(202).json(toExternalImageJob(job));
});

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
