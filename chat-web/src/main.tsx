import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Check,
  ChevronDown,
  FileText,
  Image,
  ImagePlus,
  KeyRound,
  Menu,
  MessageSquarePlus,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Send,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  User,
  X
} from "lucide-react";
import "./styles.css";

type Role = "user" | "assistant" | "system";
type Mode = "chat" | "image";
type ThemeMode = "auto" | "light" | "dark";
type ImageQuality = "standard" | "hd" | "low" | "medium" | "high";
type ImageResponseFormat = "url" | "b64_json";
type ModelFamily = "gpt" | "claude" | "other";
type ImageJobStatus = "queued" | "running" | "succeeded" | "failed";
type ChatMessageContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
type ChatMessagePayload = {
  role: "system" | "user" | "assistant";
  content: ChatMessageContent;
};

type ChatModel = {
  label: string;
  value: string;
  family: ModelFamily;
};

type ImageParams = {
  model: string;
  size: string;
  n: number;
  quality: ImageQuality;
  responseFormat: ImageResponseFormat;
};

type Message = {
  id: string;
  role: Role;
  content: string;
  imageUrl?: string;
  imageUrls?: string[];
  createdAt: number;
  pending?: boolean;
  error?: boolean;
  imageJobId?: string;
  imageJobPrompt?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "ciyuan.chat.state.v1";
const API_KEY_KEY = "ciyuan.chat.apiKey.v1";
const THEME_KEY = "ciyuan.chat.theme.v1";
const IMAGE_PARAMS_KEY = "ciyuan.chat.imageParams.v1";

const FALLBACK_MODELS: ChatModel[] = [
  { label: "GPT-5.5", value: "gpt-5.5", family: "gpt" },
  { label: "GPT-5.4", value: "gpt-5.4", family: "gpt" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini", family: "gpt" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex", family: "gpt" },
  { label: "GPT-5.2", value: "gpt-5.2", family: "gpt" }
];

const MODEL_LABELS: Record<string, string> = Object.fromEntries(FALLBACK_MODELS.map((item) => [item.value, item.label]));
const CODEX_CHAT_MODEL_IDS = new Set(FALLBACK_MODELS.map((item) => item.value));

const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024", "512x512", "1792x1024", "1024x1792"];
const IMAGE_MODELS = [
  { label: "GPT Image 2", value: "gpt-image-2" },
  { label: "GPT Image 1.5", value: "gpt-image-1.5" },
  { label: "GPT Image 1", value: "gpt-image-1" },
  { label: "GPT Image 1 Mini", value: "gpt-image-1-mini" },
  { label: "DALL-E 3", value: "dall-e-3" },
  { label: "DALL-E 2", value: "dall-e-2" }
];
const IMAGE_QUALITIES: ImageQuality[] = ["standard", "hd", "low", "medium", "high"];
const IMAGE_FORMATS: ImageResponseFormat[] = ["url", "b64_json"];
const IMAGE_COUNTS = Array.from({ length: 10 }, (_item, index) => index + 1);
const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 80000;
const DEFAULT_IMAGE_PARAMS: ImageParams = {
  model: "gpt-image-2",
  size: "1024x1024",
  n: 1,
  quality: "standard",
  responseFormat: "b64_json"
};

type Attachment = {
  id: string;
  file: File;
  kind: "image" | "text";
  name: string;
  url?: string;
};

const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "rs",
  "php",
  "rb",
  "swift",
  "kt",
  "kts",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "toml",
  "ini",
  "env",
  "log",
  "vue",
  "svelte"
]);
const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const TEXT_FILE_ACCEPT = Array.from(TEXT_FILE_EXTENSIONS)
  .map((extension) => `.${extension}`)
  .join(",");
const IMAGE_TOOL_NAME = "generate_image";

function isOpenAIImageModel(value: string) {
  return value.toLowerCase().startsWith("gpt-image");
}

function normalizeImageParams(params: ImageParams): ImageParams {
  const maxCount = params.model.toLowerCase() === "dall-e-3" ? 1 : 10;
  const n = Math.min(Math.max(Number(params.n) || 1, 1), maxCount);
  if (isOpenAIImageModel(params.model) && params.responseFormat !== "b64_json") {
    return { ...params, n, responseFormat: "b64_json" };
  }
  return { ...params, n };
}

const newId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: newId(),
    title: "新会话",
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createConversation()];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) && parsed.length ? parsed : [createConversation()];
  } catch {
    return [createConversation()];
  }
}

function loadImageParams(): ImageParams {
  try {
    const raw = localStorage.getItem(IMAGE_PARAMS_KEY);
    if (!raw) return DEFAULT_IMAGE_PARAMS;
    const parsed = JSON.parse(raw) as Partial<ImageParams>;
    const savedModel = parsed.model;
    return normalizeImageParams({
      ...DEFAULT_IMAGE_PARAMS,
      ...parsed,
      model: savedModel && IMAGE_MODELS.some((item) => item.value === savedModel) ? savedModel : DEFAULT_IMAGE_PARAMS.model,
      n: parsed.n ?? DEFAULT_IMAGE_PARAMS.n
    });
  } catch {
    return DEFAULT_IMAGE_PARAMS;
  }
}

function getInitialTheme(): ThemeMode {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "dark" || param === "light" || param === "auto") return param;
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light" || saved === "auto") return saved;
  return "auto";
}

function resolveTheme(theme: ThemeMode) {
  if (theme !== "auto") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function trimTitle(text: string) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}...` : oneLine || "新会话";
}

function errorSummary(status: number, payload: unknown) {
  const prefix = `请求失败 ${status}`;
  if (typeof payload === "string") return payload ? `${prefix}：${payload}` : prefix;
  if (payload && typeof payload === "object") {
    const body = payload as { error?: { message?: string; code?: string }; message?: string };
    const message = body.error?.message || body.message;
    const code = body.error?.code ? ` (${body.error.code})` : "";
    return message ? `${prefix}：${message}${code}` : prefix;
  }
  return prefix;
}

async function readError(response: Response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && /<\/?[a-z][\s\S]*>/i.test(text)) {
    return errorSummary(response.status, response.statusText || "上游返回非 JSON 错误");
  }
  try {
    return errorSummary(response.status, JSON.parse(text));
  } catch {
    return errorSummary(response.status, text);
  }
}

function readSseDelta(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
    const json = JSON.parse(data);
    return json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

function imageJobMessage(prompt: string, jobId: string, status: string) {
  return `${prompt}\n\n${status}\n\n任务 ID: ${jobId}`;
}

function imageJobErrorMessage(jobId: string, message: string) {
  if (message.includes(jobId)) return message;
  return `图片任务失败\n\n任务 ID: ${jobId}\n\n${message}`;
}

function shouldOfferImageTool(text: string, imageCount: number) {
  const lower = text.toLowerCase();
  if (
    /生成.*图|画.*图|生图|出图|绘制|画一|做一张|来一张|一张.*图|生成海报|生成封面|生成logo|生成头像|生成壁纸|生成表情包/.test(text)
  ) {
    return true;
  }
  if (/\b(generate|create|draw|make|render|design)\b[\s\S]{0,40}\b(image|picture|photo|poster|logo|illustration|wallpaper)\b/.test(lower)) {
    return true;
  }
  if (imageCount > 0 && /修改|改成|换成|换背景|去掉|添加|变成|修图|重绘|编辑|make|turn|remove|replace|edit/.test(lower)) {
    return true;
  }
  return false;
}

function parseJsonObject(value: unknown) {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extractImageToolPrompt(payload: unknown) {
  const message = (payload as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message as
    | {
        tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
        function_call?: { name?: string; arguments?: unknown };
      }
    | undefined;
  const toolCall = message?.tool_calls?.find((item) => item.function?.name === IMAGE_TOOL_NAME);
  const legacyCall = message?.function_call?.name === IMAGE_TOOL_NAME ? message.function_call : null;
  const args = parseJsonObject(toolCall?.function?.arguments ?? legacyCall?.arguments);
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  return prompt;
}

function extractImageUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: Array<{ url?: string; b64_json?: string }> }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (item.url) return item.url;
      if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
      return "";
    })
    .filter(Boolean);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

function fileExtension(name: string) {
  const extension = name.toLowerCase().split(".").pop() || "";
  return extension === name.toLowerCase() ? "" : extension;
}

function isTextAttachment(file: File) {
  const type = file.type.toLowerCase();
  if (type.startsWith("text/")) return true;
  if (["application/json", "application/x-ndjson", "application/xml", "application/yaml"].includes(type)) return true;
  const extension = fileExtension(file.name);
  return TEXT_FILE_EXTENSIONS.has(extension) || file.name.toLowerCase() === "dockerfile";
}

async function readTextAttachment(attachment: Attachment) {
  const text = await attachment.file.text();
  const clipped = text.length > MAX_TEXT_ATTACHMENT_CHARS;
  const content = clipped ? text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : text;
  return [
    `--- file: ${attachment.name}`,
    `mime: ${attachment.file.type || "text/plain"}`,
    `size: ${attachment.file.size} bytes${clipped ? `, truncated to ${MAX_TEXT_ATTACHMENT_CHARS} chars` : ""}`,
    "---",
    content
  ].join("\n");
}

function imageUrlsForMessage(message: Message) {
  return message.imageUrls?.length ? message.imageUrls : message.imageUrl ? [message.imageUrl] : [];
}

function modelFamily(value: string): ModelFamily {
  const lower = value.toLowerCase();
  if (lower.startsWith("claude") || lower.includes("claude")) return "claude";
  if (lower.startsWith("gpt") || lower.includes("gpt")) return "gpt";
  return "other";
}

function modelLabel(value: string) {
  if (MODEL_LABELS[value]) return MODEL_LABELS[value];
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function isChatModelId(value: string) {
  const lower = value.toLowerCase();
  return !["image", "dall-e", "embedding", "whisper", "tts", "moderation"].some((marker) => lower.includes(marker));
}

function isCodexChatModelId(value: string) {
  return CODEX_CHAT_MODEL_IDS.has(value);
}

function parseModels(payload: unknown): ChatModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  return data
    .map((item) => {
      const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
      return typeof id === "string" ? id.trim() : "";
    })
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => ({
      label: modelLabel(id),
      value: id,
      family: modelFamily(id)
    }))
    .filter((item) => item.family === "gpt" && isChatModelId(item.value) && isCodexChatModelId(item.value))
    .sort((a, b) => FALLBACK_MODELS.findIndex((item) => item.value === a.value) - FALLBACK_MODELS.findIndex((item) => item.value === b.value));
}

function groupedModels(models: ChatModel[]) {
  const groups: Array<{ family: ModelFamily; label: string; models: ChatModel[] }> = [
    { family: "gpt", label: "GPT", models: models.filter((item) => item.family === "gpt") },
    { family: "claude", label: "Claude", models: models.filter((item) => item.family === "claude") }
  ];
  return groups.filter((group) => group.models.length > 0);
}

function App() {
  const [conversations, setConversations] = React.useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = React.useState(() => conversations[0]?.id ?? createConversation().id);
  const [apiKey, setApiKey] = React.useState(() => localStorage.getItem(API_KEY_KEY) ?? "");
  const [draftKey, setDraftKey] = React.useState(apiKey);
  const [showSettings, setShowSettings] = React.useState(!apiKey);
  const [sidebarOpen, setSidebarOpen] = React.useState(() => window.matchMedia("(min-width: 761px)").matches);
  const [models, setModels] = React.useState<ChatModel[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [model, setModel] = React.useState(FALLBACK_MODELS[0].value);
  const [mode, setMode] = React.useState<Mode>("chat");
  const [theme, setTheme] = React.useState<ThemeMode>(getInitialTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState(() => resolveTheme(getInitialTheme()));
  const [imageParams, setImageParams] = React.useState<ImageParams>(loadImageParams);
  const [input, setInput] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const messagesRef = React.useRef<HTMLElement | null>(null);
  const pollingImageJobsRef = React.useRef<Set<string>>(new Set());
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = React.useRef(true);

  const active = conversations.find((item) => item.id === activeId) ?? conversations[0];
  const activeImageJobPending = Boolean(active?.messages.some((message) => message.pending && message.imageJobId));
  const interactionBusy = busy || activeImageJobPending;
  const modelGroups = groupedModels(models);
  const hasGptModels = models.some((item) => item.family === "gpt");
  const currentModel = models.find((item) => item.value === model);
  const canUseImages = hasGptModels;
  const imageResponseFormats: ImageResponseFormat[] = isOpenAIImageModel(imageParams.model) ? ["b64_json"] : IMAGE_FORMATS;
  const topbarSubtitle = modelsLoading
    ? "正在读取可用模型"
    : mode === "image"
      ? "GPT 生图接口"
      : currentModel?.family === "claude"
        ? "Claude 系列对话"
        : "GPT 系列对话";

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  React.useEffect(() => {
    localStorage.setItem(IMAGE_PARAMS_KEY, JSON.stringify(imageParams));
  }, [imageParams]);

  React.useEffect(() => {
    if (!apiKey) {
      setModels(FALLBACK_MODELS);
      setModel(FALLBACK_MODELS[0].value);
      setMode("chat");
      return;
    }

    let alive = true;
    const controller = new AbortController();
    async function loadModels() {
      setModelsLoading(true);
      try {
        const response = await fetch("/chat-api/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(await readError(response));
        const parsed = parseModels(await response.json());
        if (!parsed.length) throw new Error("模型接口未返回 GPT 或 Claude 模型。");
        if (!alive) return;
        setModels(parsed);
        setNotice("");
      } catch (error) {
        if (!alive || (error as Error).name === "AbortError") return;
        const message = (error as Error).message || "";
        const reason =
          message === "Failed to fetch" ? "无法连接 /chat-api/models，请确认前端代理和后端服务已启动。" : message;
        setModels(FALLBACK_MODELS);
        setMode("chat");
        setNotice(`模型列表读取失败，已使用默认 GPT 列表。${reason}`);
      } finally {
        if (alive) setModelsLoading(false);
      }
    }

    loadModels();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [apiKey]);

  React.useEffect(() => {
    if (!models.some((item) => item.value === model)) {
      setModel(models[0]?.value ?? FALLBACK_MODELS[0].value);
    }
    if (!models.some((item) => item.family === "gpt")) {
      setMode("chat");
    }
  }, [model, models]);

  React.useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const apply = () => {
      const next = resolveTheme(theme);
      setResolvedTheme(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  React.useEffect(() => {
    if (shouldStickToBottomRef.current) {
      scrollRef.current?.scrollIntoView({ block: "end" });
    }
  }, [active?.messages, busy]);

  React.useEffect(() => {
    const pendingJobs = conversations.flatMap((conversation) =>
      conversation.messages
        .filter((message) => message.pending && message.imageJobId)
        .map((message) => ({
          conversationId: conversation.id,
          messageId: message.id,
          jobId: message.imageJobId || "",
          prompt: message.imageJobPrompt || message.content.split("\n\n")[0] || "Image generation"
        }))
    );

    for (const job of pendingJobs) {
      if (!job.jobId || pollingImageJobsRef.current.has(job.jobId)) continue;
      pollingImageJobsRef.current.add(job.jobId);
      const controller = new AbortController();
      pollImageJob(job.conversationId, job.messageId, job.jobId, job.prompt, controller.signal)
        .catch((error) => {
          if ((error as Error).name === "AbortError") return;
          patchMessage(job.conversationId, job.messageId, {
            pending: false,
            error: true,
            imageJobId: undefined,
            imageJobPrompt: undefined,
            content: imageJobErrorMessage(job.jobId, (error as Error).message || "Image generation failed.")
          });
        })
        .finally(() => {
          pollingImageJobsRef.current.delete(job.jobId);
        });
    }
  }, [conversations]);

  function updateStickToBottom() {
    const node = messagesRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldStickToBottomRef.current = distance < 96;
  }

  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((items) =>
      items.map((item) => (item.id === id ? updater(item) : item)).sort((a, b) => b.updatedAt - a.updatedAt)
    );
  }

  function addConversation() {
    const conversation = createConversation();
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
  }

  function deleteConversation(id: string) {
    setConversations((items) => {
      const next = items.filter((item) => item.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? "");
      return next.length ? next : [createConversation()];
    });
  }

  function clearHistory() {
    const conversation = createConversation();
    setConversations([conversation]);
    setActiveId(conversation.id);
  }

  function saveKey() {
    const clean = draftKey.trim();
    setApiKey(clean);
    if (clean) localStorage.setItem(API_KEY_KEY, clean);
    else localStorage.removeItem(API_KEY_KEY);
    setShowSettings(false);
  }

  function appendMessage(conversationId: string, message: Message) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length ? conversation.title : trimTitle(message.content),
      messages: [...conversation.messages, message],
      updatedAt: Date.now()
    }));
  }

  function patchMessage(conversationId: string, messageId: string, patch: Partial<Message>) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
      updatedAt: Date.now()
    }));
  }

  async function pollImageJob(conversationId: string, assistantId: string, jobId: string, prompt: string, signal: AbortSignal) {
    while (true) {
      await wait(2000, signal);
      const statusResponse = await fetch(`/chat-api/image-jobs/${encodeURIComponent(jobId)}`, {
        signal
      });

      if (!statusResponse.ok) {
        throw new Error(imageJobErrorMessage(jobId, await readError(statusResponse)));
      }

      const job = (await statusResponse.json()) as { status?: ImageJobStatus; images?: string[]; error?: string };
      if (job.status === "queued" || job.status === "running") {
        patchMessage(conversationId, assistantId, {
          content: imageJobMessage(prompt, jobId, "正在生成图片..."),
          pending: true,
          imageJobId: jobId,
          imageJobPrompt: prompt
        });
        continue;
      }

      if (job.status === "succeeded") {
        const imageUrls = Array.isArray(job.images) ? job.images.filter(Boolean) : extractImageUrls(job);
        if (!imageUrls.length) throw new Error(imageJobErrorMessage(jobId, "Image job completed without a displayable image URL."));
        patchMessage(conversationId, assistantId, {
          content: imageJobMessage(prompt, jobId, `已生成 ${imageUrls.length} 张图片，请尽快保存，临时图片稍后会清理。`),
          imageUrls,
          pending: false,
          imageJobId: undefined,
          imageJobPrompt: undefined
        });
        return;
      }

      if (job.status === "failed") {
        throw new Error(imageJobErrorMessage(jobId, job.error || "Image generation failed."));
      }

      throw new Error(imageJobErrorMessage(jobId, "Image job returned an unknown status."));
    }
  }

  function conversationMessages(conversationId: string, currentUserContent: ChatMessageContent): ChatMessagePayload[] {
    const currentMessages =
      conversations.find((conversation) => conversation.id === conversationId)?.messages.filter((message) => !message.error) ?? [];
    return [
      ...currentMessages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
      { role: "user" as const, content: currentUserContent }
    ];
  }

  async function maybeRunImageTool(
    conversationId: string,
    assistantId: string,
    messages: ChatMessagePayload[],
    textContent: string,
    imageAttachments: Attachment[],
    signal: AbortSignal
  ) {
    if (!shouldOfferImageTool(textContent, imageAttachments.length)) return false;

    const response = await fetch("/chat-api/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "If the user asks to create, draw, generate, edit, or transform an image, call generate_image with a clear prompt. For ordinary questions, answer normally."
          },
          ...messages
        ],
        tools: [
          {
            type: "function",
            function: {
              name: IMAGE_TOOL_NAME,
              description: "Generate or edit an image for the user. Use attached images as references when present.",
              parameters: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description: "A concise image generation or image edit prompt, preserving the user's intent and important visual details."
                  }
                },
                required: ["prompt"]
              }
            }
          }
        ],
        tool_choice: "auto"
      }),
      signal
    });

    if (!response.ok) return false;
    const prompt = extractImageToolPrompt(await response.json());
    if (!prompt) return false;

    patchMessage(conversationId, assistantId, { content: `正在调用生图工具：${prompt}`, pending: true });
    await sendImage(conversationId, prompt, assistantId, imageAttachments);
    return true;
  }

  async function sendChat(conversationId: string, userText: string, assistantId: string, selectedAttachments: Attachment[]) {
    const controller = new AbortController();
    abortRef.current = controller;
    const imageAttachments = selectedAttachments.filter((attachment) => attachment.kind === "image");
    const textAttachments = selectedAttachments.filter((attachment) => attachment.kind === "text");
    const fileText = textAttachments.length ? (await Promise.all(textAttachments.map(readTextAttachment))).join("\n\n") : "";
    const textContent = [userText || (imageAttachments.length ? "Please analyze the attached image." : "Please analyze the attached files."), fileText]
      .filter(Boolean)
      .join("\n\nAttached files:\n");
    const currentUserContent: ChatMessageContent =
      imageAttachments.length > 0
        ? [
            { type: "text" as const, text: textContent },
            ...(await Promise.all(imageAttachments.map(async (attachment) => ({
              type: "image_url" as const,
              image_url: { url: await fileToDataUrl(attachment.file) }
            }))))
          ]
        : textContent;
    const messages = conversationMessages(conversationId, currentUserContent);

    try {
      if (await maybeRunImageTool(conversationId, assistantId, messages, textContent, imageAttachments, controller.signal)) {
        return;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
    }

    const response = await fetch("/chat-api/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(await readError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const applyDelta = (line: string) => {
      const delta = readSseDelta(line);
      if (!delta) return;
      content += delta;
      patchMessage(conversationId, assistantId, { content, pending: true });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        applyDelta(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) applyDelta(buffer);

    patchMessage(conversationId, assistantId, { content: content || "（空响应）", pending: false });
  }

  async function sendImage(conversationId: string, prompt: string, assistantId: string, imageAttachments: Attachment[]) {
    const controller = new AbortController();
    abortRef.current = controller;
    let requestBody: BodyInit;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`
    };

    if (imageAttachments.length > 0) {
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("size", imageParams.size);
      form.append("n", String(imageParams.n));
      form.append("quality", imageParams.quality);
      form.append("response_format", imageParams.responseFormat);
      form.append("model", imageParams.model);
      for (const attachment of imageAttachments) {
        form.append("image[]", attachment.file, attachment.name);
      }
      requestBody = form;
    } else {
      const body: Record<string, string | number> = {
        prompt,
        size: imageParams.size,
        n: imageParams.n,
        quality: imageParams.quality,
        response_format: imageParams.responseFormat
      };
      body.model = imageParams.model;
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const response = await fetch("/chat-api/image-jobs", {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const created = (await response.json()) as { job_id?: string; status?: ImageJobStatus };
    if (!created.job_id) throw new Error("生图任务创建失败。");

    pollingImageJobsRef.current.add(created.job_id);
    patchMessage(conversationId, assistantId, {
      content: imageJobMessage(prompt, created.job_id, "正在生成图片..."),
      pending: true,
      imageJobId: created.job_id,
      imageJobPrompt: prompt
    });
    try {
      await pollImageJob(conversationId, assistantId, created.job_id, prompt, controller.signal);
    } finally {
      pollingImageJobsRef.current.delete(created.job_id);
    }
  }

  async function submit() {
    const text = input.trim();
    const selectedAttachments = attachments;
    if ((!text && selectedAttachments.length === 0) || busyRef.current) return;
    if (activeImageJobPending) {
      setNotice("当前图片任务仍在处理，请等待结果或失败后再发送。");
      return;
    }
    if (mode === "image" && !text) {
      setNotice("Image generation needs a prompt.");
      return;
    }
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (mode === "image" && !canUseImages) {
      setMode("chat");
      setNotice("当前 Key 只返回 Claude 模型，暂不支持生图。");
      return;
    }

    const conversationId = active.id;
    const assistantId = newId();
    busyRef.current = true;
    setInput("");
    setAttachments([]);
    setBusy(true);
    setNotice("");

    const fileNames = selectedAttachments.filter((attachment) => attachment.kind === "text").map((attachment) => attachment.name);
    const displayContent = [text, fileNames.length ? `Attached files: ${fileNames.join(", ")}` : ""].filter(Boolean).join("\n\n");
    const imageUrls = selectedAttachments
      .filter((attachment) => attachment.kind === "image" && attachment.url)
      .map((attachment) => attachment.url as string);

    appendMessage(conversationId, {
      id: newId(),
      role: "user",
      content:
        displayContent ||
        (selectedAttachments.some((attachment) => attachment.kind === "image")
          ? "Attached image"
          : `Attached ${selectedAttachments.length} file${selectedAttachments.length > 1 ? "s" : ""}`),
      imageUrls,
      createdAt: Date.now()
    });
    appendMessage(conversationId, {
      id: assistantId,
      role: "assistant",
      content: mode === "chat" ? "" : "正在生成图片...",
      createdAt: Date.now(),
      pending: true
    });

    try {
      if (mode === "chat") await sendChat(conversationId, text, assistantId, selectedAttachments);
      else await sendImage(conversationId, text, assistantId, selectedAttachments);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        patchMessage(conversationId, assistantId, { pending: false, content: "已停止生成。" });
      } else {
        patchMessage(conversationId, assistantId, {
          pending: false,
          error: true,
          content: (error as Error).message || "请求失败。"
        });
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function addAttachmentFiles(files: File[]) {
    if (!files.length) return;
    const rejected: string[] = [];
    const acceptedFiles = files
      .map((file) => {
        if (file.type.startsWith("image/")) {
          if (file.size <= MAX_ATTACHMENT_BYTES) return { file, kind: "image" as const };
          rejected.push(`${file.name || "image"} exceeds 20MB`);
          return null;
        }
        if (mode !== "chat") {
          rejected.push(`${file.name || "file"} is not an image`);
          return null;
        }
        if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
          rejected.push(`${file.name || "file"} exceeds 1MB`);
          return null;
        }
        if (!isTextAttachment(file)) {
          rejected.push(`${file.name || "file"} is not a supported text file`);
          return null;
        }
        return { file, kind: "text" as const };
      })
      .filter((item): item is { file: File; kind: "image" | "text" } => Boolean(item));
    if (rejected.length) {
      setNotice(`Some files were skipped: ${rejected.slice(0, 3).join("; ")}${rejected.length > 3 ? "..." : ""}`);
    }
    setAttachments((current) => {
      const available = Math.max(MAX_ATTACHMENTS - current.length, 0);
      const accepted = acceptedFiles.slice(0, available).map(({ file, kind }) => ({
        id: newId(),
        kind,
        file,
        name: file.name || (kind === "image" ? "image" : "file"),
        url: kind === "image" ? URL.createObjectURL(file) : undefined
      }));
      if (acceptedFiles.length > available) {
        setNotice(`Upload at most ${MAX_ATTACHMENTS} attachments.`);
      }
      return [...current, ...accepted];
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function addAttachments(files: FileList | null) {
    addAttachmentFiles(files ? Array.from(files) : []);
  }

  function pasteImageAttachments(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (busy) return;
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
        const extension =
          fileExtension(file.name) || file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase() || (file.type.startsWith("image/") ? "png" : "txt");
        const name = file.name || `pasted-file-${Date.now()}-${index + 1}.${extension}`;
        return new File([file], name, { type: file.type || "application/octet-stream", lastModified: Date.now() });
      })
      .filter((file): file is File => Boolean(file));

    if (!files.length) return;
    event.preventDefault();
    addAttachmentFiles(files);
  }

  async function useImageForEdit(url: string) {
    if (!canUseImages) {
      setNotice("Image editing needs a GPT-capable key.");
      return;
    }
    if (busy) {
      setNotice("Wait for the current response to finish before editing an image.");
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      setNotice(`Upload at most ${MAX_ATTACHMENTS} attachments.`);
      return;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Image download failed ${response.status}.`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Selected asset is not an image.");
      const extension = blob.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
      const file = new File([blob], `edit-reference-${Date.now()}.${extension}`, { type: blob.type || "image/png", lastModified: Date.now() });
      setAttachments((current) => [
        ...current,
        {
          id: newId(),
          kind: "image",
          file,
          name: file.name,
          url: URL.createObjectURL(file)
        }
      ]);
      setMode("image");
      setInput("");
      setNotice("Image added as an edit reference. Describe the changes you want.");
    } catch (error) {
      setNotice((error as Error).message || "Could not use this image for editing.");
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const item = current.find((attachment) => attachment.id === id);
      if (item?.url) URL.revokeObjectURL(item.url);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function updateImageParam<K extends keyof ImageParams>(key: K, value: ImageParams[K]) {
    setImageParams((current) => normalizeImageParams({ ...current, [key]: value }));
  }

  function switchMode(nextMode: Mode) {
    if (busyRef.current || activeImageJobPending) {
      setNotice("请等待当前响应结束后再切换模式。");
      return;
    }
    if (nextMode === "image" && !canUseImages) {
      setMode("chat");
      setNotice("当前 Key 只返回 Claude 模型，暂不支持生图。");
      return;
    }
    if (nextMode === "image") {
      setAttachments((current) => current.filter((attachment) => attachment.kind === "image"));
    }
    setMode(nextMode);
  }

  function renderModelSelect() {
    return (
      <label className="select-field compact model-select">
        <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="选择模型" disabled={modelsLoading}>
          {modelGroups.length > 1
            ? modelGroups.map((group) => (
                <optgroup key={group.family} label={group.label}>
                  {group.models.map((item) => (
                    <option value={item.value} key={item.value}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ))
            : models.map((item) => (
                <option value={item.value} key={item.value}>
                  {item.label}
                </option>
              ))}
        </select>
        <ChevronDown size={16} />
      </label>
    );
  }

  return (
    <div className="app-shell" data-resolved-theme={resolvedTheme}>
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>Chat</strong>
          </div>
          <button className="icon-button" title="收起侧边栏" onClick={() => setSidebarOpen(false)}>
            <PanelRightClose size={19} />
          </button>
        </div>
        <div className="sidebar-top">
          <button className="new-chat" onClick={addConversation}>
            <MessageSquarePlus size={18} />
            <span>新会话</span>
          </button>
        </div>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`conversation-item ${conversation.id === active.id ? "active" : ""}`}
              onClick={() => setActiveId(conversation.id)}
            >
              <span>{conversation.title}</span>
              <Trash2
                size={16}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteConversation(conversation.id);
                }}
              />
            </button>
          ))}
        </div>
        <div className="sidebar-actions">
          <button onClick={clearHistory}>
            <Trash2 size={17} />
            <span>清空历史</span>
          </button>
          <button onClick={() => setShowSettings(true)}>
            <Settings size={17} />
            <span>设置</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu" title="菜单" onClick={() => setSidebarOpen((value) => !value)}>
            <Menu size={19} />
          </button>
          <div className="topbar-title">
            <strong>{mode === "chat" ? "智能对话" : "图像生成"}</strong>
            <span>{topbarSubtitle}</span>
          </div>
          <div className="topbar-controls">
            <div className="mode-switch topbar-mode-switch" role="tablist" aria-label="模式">
              <button className={mode === "chat" ? "active" : ""} onClick={() => switchMode("chat")} disabled={interactionBusy}>
                <Bot size={16} />
                <span>对话</span>
              </button>
              {canUseImages && (
                <button className={mode === "image" ? "active" : ""} onClick={() => switchMode("image")} disabled={interactionBusy}>
                  <Image size={16} />
                  <span>生图</span>
                </button>
              )}
            </div>
            <button className="theme-button" onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")}>
              {theme === "dark" ? <Moon size={16} /> : theme === "light" ? <Sun size={16} /> : <Sparkles size={16} />}
              <span>{theme === "auto" ? "自动" : theme === "light" ? "浅色" : "深色"}</span>
            </button>
          </div>
          <button className="key-state" onClick={() => setShowSettings(true)}>
            {apiKey ? <Check size={16} /> : <KeyRound size={16} />}
            <span>{apiKey ? "Key 已保存" : "填写 Key"}</span>
          </button>
          {!sidebarOpen && (
            <button className="icon-button right-toggle" title="展开侧边栏" onClick={() => setSidebarOpen(true)}>
              <PanelRightOpen size={19} />
            </button>
          )}
        </header>

        <section className="messages" aria-live="polite" ref={messagesRef} onScroll={updateStickToBottom}>
          {active.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Bot size={34} />
              </div>
              <h1>词元.fast Chat</h1>
              <p>开始一段对话，或切换到生图模式生成图片。</p>
            </div>
          ) : (
            active.messages.map((message) => {
              const urls = imageUrlsForMessage(message);
              return (
                <article key={message.id} className={`message ${message.role} ${message.error ? "error" : ""}`}>
                  <div className="avatar">{message.role === "user" ? <User size={17} /> : <Bot size={17} />}</div>
                  <div className="message-body">
                    {urls.length > 0 && (
                      <div className={`image-grid count-${Math.min(urls.length, 4)}`}>
                        {urls.map((url, index) => (
                          <div key={`${url}-${index}`} className="image-tile">
                            <button className="image-thumb" onClick={() => setPreviewImage(url)}>
                            <img src={url} alt={`${message.content || "生成图片"} ${index + 1}`} />
                            </button>
                            <button className="image-edit-button" title="Edit this image" onClick={() => useImageForEdit(url)}>
                              <ImagePlus size={15} />
                              <span>Edit</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (message.pending ? "正在生成..." : "")}</ReactMarkdown>
                    {message.pending && <span className="cursor" />}
                  </div>
                </article>
              );
            })
          )}
          <div ref={scrollRef} />
        </section>

        <footer className="composer-wrap">
          {notice && <div className="notice">{notice}</div>}
          <div className="composer-panel">
            <div className="composer-params">
              {mode === "chat" && renderModelSelect()}
              {mode === "image" && canUseImages && (
                <>
                <label className="select-field compact">
                  <select value={imageParams.model} onChange={(event) => updateImageParam("model", event.target.value)} aria-label="选择生图模型">
                    {IMAGE_MODELS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                <label className="select-field compact">
                  <select value={imageParams.size} onChange={(event) => updateImageParam("size", event.target.value)} aria-label="选择图片尺寸">
                    {IMAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                <label className="select-field compact">
                  <select
                    value={imageParams.n}
                    onChange={(event) => updateImageParam("n", Number(event.target.value))}
                    aria-label="Select image count"
                    disabled={imageParams.model.toLowerCase() === "dall-e-3"}
                  >
                    {IMAGE_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {count} img
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                <label className="select-field compact">
                  <select
                    value={imageParams.quality}
                    onChange={(event) => updateImageParam("quality", event.target.value as ImageQuality)}
                    aria-label="选择图片质量"
                  >
                    {IMAGE_QUALITIES.map((quality) => (
                      <option key={quality} value={quality}>
                        {quality}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                <label className="select-field compact">
                  <select
                    value={imageParams.responseFormat}
                    onChange={(event) => updateImageParam("responseFormat", event.target.value as ImageResponseFormat)}
                    aria-label="选择图片返回格式"
                    disabled={imageResponseFormats.length === 1}
                  >
                    {imageResponseFormats.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                </>
              )}
            </div>

            {attachments.length > 0 && (
              <div className="attachment-tray">
                {attachments.map((attachment) => (
                  <div className="attachment-chip" key={attachment.id}>
                    {attachment.kind === "image" && attachment.url ? (
                      <button type="button" onClick={() => setPreviewImage(attachment.url || null)}>
                        <img src={attachment.url} alt={attachment.name} />
                      </button>
                    ) : (
                      <div className="attachment-file-icon">
                        <FileText size={18} />
                      </div>
                    )}
                    <span>{attachment.name}</span>
                    <button type="button" className="attachment-remove" onClick={() => removeAttachment(attachment.id)} aria-label="Remove attachment">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="composer">
              <input
                ref={fileInputRef}
                type="file"
                accept={mode === "chat" ? `${IMAGE_FILE_ACCEPT},${TEXT_FILE_ACCEPT}` : IMAGE_FILE_ACCEPT}
                multiple
                className="file-input"
                onChange={(event) => addAttachments(event.target.files)}
              />
              <button
                className="attach-button"
                title={mode === "chat" ? "Attach file or image" : "Attach reference image"}
                onClick={() => fileInputRef.current?.click()}
                disabled={interactionBusy || attachments.length >= MAX_ATTACHMENTS}
              >
                <Paperclip size={18} />
              </button>
              <textarea
                value={input}
                placeholder={mode === "chat" ? "输入消息..." : "描述你想生成的图片..."}
                onChange={(event) => setInput(event.target.value)}
                onPaste={pasteImageAttachments}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
              />
              {busy ? (
                <button className="send-button" title="停止生成" onClick={stop}>
                  <Square size={18} />
                </button>
              ) : (
                <button className="send-button" title="发送" onClick={submit} disabled={activeImageJobPending}>
                  <Send size={18} />
                </button>
              )}
            </div>
          </div>
        </footer>
      </main>

      {showSettings && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-head">
              <h2>API Key</h2>
              <button className="icon-button" title="关闭" onClick={() => setShowSettings(false)}>
                <X size={18} />
              </button>
            </div>
            <label>
              <span>Authorization Bearer Key</span>
              <input
                autoFocus
                type="password"
                value={draftKey}
                placeholder="sk-..."
                onChange={(event) => setDraftKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveKey();
                }}
              />
            </label>
            <p>Key 只保存在当前浏览器 localStorage，代理不存储。</p>
            <div className="modal-actions">
              <button onClick={() => setShowSettings(false)}>取消</button>
              <button className="primary" onClick={saveKey}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {previewImage && (
        <div className="preview-backdrop" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}>
          <button className="preview-close" title="关闭" onClick={() => setPreviewImage(null)}>
            <X size={20} />
          </button>
          <img src={previewImage} alt="图片预览" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
