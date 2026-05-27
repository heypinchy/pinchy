import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 9100;

// ---- Control ----
app.get("/control/health", (_req, res) => res.json({ ok: true }));

// ---- OpenAI ----
app.get("/openai/v1/models", (req, res) => {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "Missing API key" } });
  }
  res.json({
    object: "list",
    data: [
      { id: "gpt-5.5-2026-04-23", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-5.5", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-5.4", object: "model", created: 1700000000, owned_by: "openai" },
      { id: "gpt-5.4-mini", object: "model", created: 1700000000, owned_by: "openai" },
    ],
  });
});

app.post("/openai/v1/chat/completions", (req, res) => {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "Missing API key" } });
  }
  const reply = "Sure, happy to help! What would you like to work on?";
  res.json({
    id: "chatcmpl-mock-1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.body?.model ?? "gpt-5.5",
    choices: [
      { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
  });
});

app.listen(PORT, () => console.log(`llm-providers-mock listening on ${PORT}`));
