import "dotenv/config";
import express from "express";
import helmet from "helmet";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_BASE = (process.env.VSELLM_BASE_URL || "https://api.vsellm.ru/v1").replace(/\/+$/, "");
const MODEL = process.env.VSELLM_MODEL || "openai/gpt-5";
const API_KEY = process.env.VSELLM_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

if (!API_KEY || !APP_PASSWORD || !SESSION_SECRET) {
  console.error("Заполни VSELLM_API_KEY, APP_PASSWORD и SESSION_SECRET в .env");
  process.exit(1);
}
if (APP_PASSWORD.length < 12 || SESSION_SECRET.length < 32) {
  console.error("APP_PASSWORD должен быть от 12 символов, SESSION_SECRET — от 32.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "64kb" }));

const sessions = new Map();
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function makeCookie(id) {
  const payload = `${id}.${Date.now() + 7 * 24 * 60 * 60 * 1000}`;
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || "").split(";").map(v => v.trim())
    .find(v => v.startsWith("jarvis_session="))?.slice("jarvis_session=".length);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(sign(payload), parts[2]) || Number(parts[1]) < Date.now()) return false;
  return true;
}
function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}${IS_PROD ? "; Secure" : ""}`;
}
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let item = attempts.get(ip);
  if (!item || now - item.start > WINDOW) item = { start: now, count: 0 };
  item.count++;
  attempts.set(ip, item);
  if (item.count > 80) return res.status(429).json({ error: "Слишком много запросов. Подожди немного." });
  next();
}
function requireLogin(req, res, next) {
  if (!readSession(req)) return res.status(401).json({ error: "Сначала войди в JARVIS." });
  next();
}

app.post("/api/login", rateLimit, (req, res) => {
  const password = req.body?.password;
  if (typeof password !== "string" || !safeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: "Неверный пароль." });
  }
  const id = crypto.randomBytes(32).toString("hex");
  res.setHeader("Set-Cookie", `jarvis_session=${makeCookie(id)}; ${cookieOptions()}`);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "jarvis_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", (req, res) => res.json({ authenticated: readSession(req) }));

app.get("/api/models", requireLogin, async (req, res) => {
  try {
    const r = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data?.detail || data?.error?.message || "Не удалось получить список моделей." });
    res.json({ models: (data.data || []).map(m => ({ id: m.id, name: m.id })) });
  } catch {
    res.status(502).json({ error: "Не удалось связаться с VseLLM." });
  }
});

app.post("/api/chat", requireLogin, rateLimit, async (req, res) => {
  const messages = req.body?.messages;
  const model = typeof req.body?.model === "string" ? req.body.model : MODEL;
  const allowed = /^[a-zA-Z0-9._/-]{1,120}$/.test(model);
  if (!allowed) return res.status(400).json({ error: "Некорректный идентификатор модели." });
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 40) {
    return res.status(400).json({ error: "Некорректная история диалога." });
  }
  const clean = [];
  for (const m of messages) {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 12000) {
      return res.status(400).json({ error: "Сообщение имеет неверный формат или слишком длинное." });
    }
    clean.push({ role: m.role, content: m.content });
  }
  const system = {
    role: "system",
    content: "Ты JARVIS — дружелюбный, умный голосовой помощник пользователя. Отвечай на русском, если пользователь не просит другой язык. Будь естественным, полезным и конкретным. Не утверждай, что выполнил действия на устройстве, если у тебя нет соответствующего инструмента."
  };
  try {
    const upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [system, ...clean], temperature: 0.7 })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = data?.error?.message || data?.detail || `Ошибка VseLLM (${upstream.status})`;
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({ error: message });
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) return res.status(502).json({ error: "Модель вернула пустой ответ." });
    res.json({ answer, model: data.model || model, usage: data.usage || null });
  } catch (e) {
    res.status(502).json({ error: "Ошибка соединения с VseLLM. Проверь интернет и настройки сервера." });
  }
});

app.use(express.static("public"));
app.get("*", (req, res) => res.sendFile(process.cwd() + "/public/index.html"));
app.listen(PORT, "0.0.0.0", () => console.log(`JARVIS запущен: http://localhost:${PORT}`));
