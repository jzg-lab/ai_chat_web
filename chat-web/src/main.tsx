import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Check,
  ChevronDown,
  Image,
  KeyRound,
  Menu,
  MessageSquarePlus,
  Moon,
  PanelRightClose,
  PanelRightOpen,
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
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex", family: "gpt" },
  { label: "GPT-5.2", value: "gpt-5.2", family: "gpt" }
];

const MODEL_LABELS: Record<string, string> = Object.fromEntries(FALLBACK_MODELS.map((item) => [item.value, item.label]));

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
const DEFAULT_IMAGE_PARAMS: ImageParams = {
  model: "gpt-image-2",
  size: "1024x1024",
  n: 1,
  quality: "standard",
  responseFormat: "url"
};

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
    return {
      ...DEFAULT_IMAGE_PARAMS,
      ...parsed,
      model: savedModel && IMAGE_MODELS.some((item) => item.value === savedModel) ? savedModel : DEFAULT_IMAGE_PARAMS.model,
      n: 1
    };
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
    .filter((item) => (item.family === "gpt" || item.family === "claude") && isChatModelId(item.value));
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
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const messagesRef = React.useRef<HTMLElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = React.useRef(true);

  const active = conversations.find((item) => item.id === activeId) ?? conversations[0];
  const modelGroups = groupedModels(models);
  const hasGptModels = models.some((item) => item.family === "gpt");
  const currentModel = models.find((item) => item.value === model);
  const canUseImages = hasGptModels;
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

  async function sendChat(conversationId: string, userText: string, assistantId: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    const currentMessages =
      conversations.find((conversation) => conversation.id === conversationId)?.messages.filter((message) => !message.error) ?? [];

    const response = await fetch("/chat-api/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          ...currentMessages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({ role: message.role, content: message.content })),
          { role: "user", content: userText }
        ]
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

  async function sendImage(conversationId: string, prompt: string, assistantId: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    const body: Record<string, string | number> = {
      prompt,
      size: imageParams.size,
      n: 1,
      quality: imageParams.quality,
      response_format: imageParams.responseFormat
    };
    body.model = imageParams.model;

    const response = await fetch("/chat-api/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = await response.json();
    const imageUrls = extractImageUrls(payload);
    if (!imageUrls.length) throw new Error("生图接口未返回可显示的图片地址。");
    patchMessage(conversationId, assistantId, {
      content: `${prompt}\n\n已生成 ${imageUrls.length} 张图片。`,
      imageUrls,
      pending: false
    });
  }

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
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
    setInput("");
    setBusy(true);
    setNotice("");

    appendMessage(conversationId, {
      id: newId(),
      role: "user",
      content: text,
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
      if (mode === "chat") await sendChat(conversationId, text, assistantId);
      else await sendImage(conversationId, text, assistantId);
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
      setBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function updateImageParam<K extends keyof ImageParams>(key: K, value: ImageParams[K]) {
    setImageParams((current) => ({ ...current, [key]: value }));
  }

  function switchMode(nextMode: Mode) {
    if (nextMode === "image" && !canUseImages) {
      setMode("chat");
      setNotice("当前 Key 只返回 Claude 模型，暂不支持生图。");
      return;
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
              <button className={mode === "chat" ? "active" : ""} onClick={() => switchMode("chat")}>
                <Bot size={16} />
                <span>对话</span>
              </button>
              {canUseImages && (
                <button className={mode === "image" ? "active" : ""} onClick={() => switchMode("image")}>
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
                          <button key={`${url}-${index}`} className="image-thumb" onClick={() => setPreviewImage(url)}>
                            <img src={url} alt={`${message.content || "生成图片"} ${index + 1}`} />
                          </button>
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
              {renderModelSelect()}
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
                  >
                    {IMAGE_FORMATS.map((format) => (
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

            <div className="composer">
              <textarea
                value={input}
                placeholder={mode === "chat" ? "输入消息..." : "描述你想生成的图片..."}
                onChange={(event) => setInput(event.target.value)}
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
                <button className="send-button" title="发送" onClick={submit}>
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
