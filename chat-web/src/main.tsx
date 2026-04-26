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

const MODELS = [
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
  { label: "GPT-5.2", value: "gpt-5.2" }
];

const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024", "512x512", "1792x1024", "1024x1792"];
const IMAGE_MODELS = [
  { label: "image1", value: "image1" },
  { label: "image1.5", value: "image1.5" },
  { label: "image2", value: "image2" }
];
const IMAGE_QUALITIES: ImageQuality[] = ["standard", "hd", "low", "medium", "high"];
const IMAGE_FORMATS: ImageResponseFormat[] = ["url", "b64_json"];
const DEFAULT_IMAGE_PARAMS: ImageParams = {
  model: "image1",
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

function App() {
  const [conversations, setConversations] = React.useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = React.useState(() => conversations[0]?.id ?? createConversation().id);
  const [apiKey, setApiKey] = React.useState(() => localStorage.getItem(API_KEY_KEY) ?? "");
  const [draftKey, setDraftKey] = React.useState(apiKey);
  const [showSettings, setShowSettings] = React.useState(!apiKey);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [model, setModel] = React.useState(MODELS[0].value);
  const [mode, setMode] = React.useState<Mode>("chat");
  const [theme, setTheme] = React.useState<ThemeMode>(getInitialTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState(() => resolveTheme(getInitialTheme()));
  const [imageParams, setImageParams] = React.useState<ImageParams>(loadImageParams);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const active = conversations.find((item) => item.id === activeId) ?? conversations[0];

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  React.useEffect(() => {
    localStorage.setItem(IMAGE_PARAMS_KEY, JSON.stringify(imageParams));
  }, [imageParams]);

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
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [active?.messages, busy]);

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
            <span>{mode === "chat" ? "实时流式输出" : "OpenAI 风格图片接口"}</span>
          </div>
          {mode === "chat" ? (
            <label className="select-field compact">
              <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="选择模型">
                {MODELS.map((item) => (
                  <option value={item.value} key={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} />
            </label>
          ) : (
            <div className="image-state">
              <Image size={16} />
              <span>生图参数已启用</span>
            </div>
          )}
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

        <section className="messages" aria-live="polite">
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
            <div className="composer-toolbar">
              <div className="mode-switch" role="tablist" aria-label="模式">
                <button className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}>
                  <Bot size={16} />
                  <span>对话</span>
                </button>
                <button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>
                  <Image size={16} />
                  <span>生图</span>
                </button>
              </div>
              <button className="theme-button" onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")}>
                {theme === "dark" ? <Moon size={16} /> : theme === "light" ? <Sun size={16} /> : <Sparkles size={16} />}
                <span>{theme === "auto" ? "自动" : theme === "light" ? "浅色" : "深色"}</span>
              </button>
            </div>

            {mode === "image" && (
              <div className="image-params">
                <label>
                  <span>模型</span>
                  <select value={imageParams.model} onChange={(event) => updateImageParam("model", event.target.value)}>
                    {IMAGE_MODELS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>尺寸</span>
                  <select value={imageParams.size} onChange={(event) => updateImageParam("size", event.target.value)}>
                    {IMAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>质量</span>
                  <select
                    value={imageParams.quality}
                    onChange={(event) => updateImageParam("quality", event.target.value as ImageQuality)}
                  >
                    {IMAGE_QUALITIES.map((quality) => (
                      <option key={quality} value={quality}>
                        {quality}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>格式</span>
                  <select
                    value={imageParams.responseFormat}
                    onChange={(event) => updateImageParam("responseFormat", event.target.value as ImageResponseFormat)}
                  >
                    {IMAGE_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

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
