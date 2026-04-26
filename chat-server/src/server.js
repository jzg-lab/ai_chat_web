import compression from "compression";
import express from "express";
import helmet from "helmet";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.SUB2API_BASE_URL || "https://ciyuan.fast").replace(/\/+$/, "");
const chatEndpoint = process.env.CHAT_COMPLETIONS_ENDPOINT || "/v1/chat/completions";
const imageEndpoint = process.env.IMAGE_ENDPOINT || "/v1/images/generations";
const imageModel = process.env.IMAGE_MODEL || "";
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);
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
  return authorization;
}

async function forwardJson(req, res, endpoint, body) {
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
    upstream = await fetch(joinUrl(baseUrl, endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization
      },
      body: JSON.stringify(body),
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

app.post("/chat-api/chat/completions", async (req, res) => {
  await forwardJson(req, res, chatEndpoint, req.body);
});

app.post("/chat-api/images/generations", async (req, res) => {
  const body = { ...req.body };
  if (imageModel && !body.model) {
    body.model = imageModel;
  }
  await forwardJson(req, res, imageEndpoint, body);
});

app.get("/chat-api/health", (_req, res) => {
  res.json({ ok: true });
});

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
