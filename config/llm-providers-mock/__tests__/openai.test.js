import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 9100;
let server;

test.before(async () => {
  server = spawn("node", ["server.js"], { cwd: import.meta.dirname + "/..", env: { ...process.env, PORT } });
  await new Promise((r) => setTimeout(r, 500));
});

test.after(() => server.kill());

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
