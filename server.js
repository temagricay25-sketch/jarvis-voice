
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.VSELLM_API_KEY;
const BASE = (process.env.VSELLM_BASE_URL || "https://api.vsellm.ru/v1").replace(/\/+$/, "");
const MODEL = process.env.VSELLM_MODEL || "openai/gpt-5";

if (!KEY) {
  console.error("Set VSELLM_API_KEY in environment variables.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({
  windowMs: 60000,
  limit: 30
}));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, model } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Нет сообщений" });
    }

    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || MODEL,
        messages,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(90000)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Ошибка VseLLM"
      });
    }

    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Главная страница лежит в корне репозитория
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("JARVIS запущен на порту " + PORT);
});
