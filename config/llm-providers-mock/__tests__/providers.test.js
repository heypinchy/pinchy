import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 9100;
let server;

test.before(async () => {
  server = spawn("node", ["server.js"], { cwd: import.meta.dirname + "/..", env: { ...process.env, PORT } });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/control/health`);
      if (r.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("mock server failed to become healthy within 5s");
});

test.after(() => server?.kill());

test("GET /openai/v1/models returns OpenAI-shaped models payload", async () => {
  const res = await fetch(`http://localhost:${PORT}/openai/v1/models`, {
    headers: { Authorization: "Bearer sk-mock-any-key" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.ok(body.data.find((m) => m.id === "gpt-5.5-2026-04-23"));
});

test("POST /openai/v1/chat/completions returns deterministic non-streaming response", async () => {
  const res = await fetch(`http://localhost:${PORT}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-mock", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.role, "assistant");
  assert.ok(body.choices[0].message.content.length > 0);
});

test("GET /control/health returns 200", async () => {
  const res = await fetch(`http://localhost:${PORT}/control/health`);
  assert.equal(res.status, 200);
});

test("GET /anthropic/v1/models with x-api-key returns Anthropic shape", async () => {
  const res = await fetch(`http://localhost:${PORT}/anthropic/v1/models`, {
    headers: { "x-api-key": "sk-ant-mock", "anthropic-version": "2023-06-01" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.find((m) => m.id === "claude-sonnet-4-6"));
});

test("POST /anthropic/v1/messages returns Anthropic message shape", async () => {
  const res = await fetch(`http://localhost:${PORT}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "sk-ant-mock", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].type, "text");
});

test("GET /google/v1beta/models with key query param returns Gemini shape", async () => {
  const res = await fetch(`http://localhost:${PORT}/google/v1beta/models?key=AIza-mock`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.models.find((m) => m.name === "models/gemini-2.5-pro"));
});

test("POST /google/v1beta/models/gemini-2.5-pro:generateContent returns Gemini shape", async () => {
  const res = await fetch(`http://localhost:${PORT}/google/v1beta/models/gemini-2.5-pro:generateContent?key=AIza-mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.candidates[0].content.parts[0].text.length > 0, true);
});
