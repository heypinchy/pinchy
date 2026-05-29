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

test("GET /ollama-cloud/v1/models with Bearer returns models list", async () => {
  const res = await fetch(`http://localhost:${PORT}/ollama-cloud/v1/models`, {
    headers: { Authorization: "Bearer sk-ollama-mock" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.ok(body.data.find((m) => m.id === "qwen3-next:80b"));
});

test("POST /google/v1beta/models/X:streamGenerateContent with x-goog-api-key header is accepted", async () => {
  // pi-ai's @google/genai SDK passes the key via header at chat time, not
  // ?key= query (which only validateProviderKey uses). Live CI showed OC
  // hitting the endpoint with x-goog-api-key and getting 403 missing-key.
  const res = await fetch(
    `http://localhost:${PORT}/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "x-goog-api-key": "AIza-mock-header", "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
    }
  );
  assert.equal(res.status, 200);
});

test("POST /google/v1beta/models/X:streamGenerateContent?alt=sse returns SSE candidates", async () => {
  // pi-ai's @google/genai SDK calls :streamGenerateContent with alt=sse
  // (visible in mock log of prior CI runs). Response is SSE: each chunk is
  // `data: <JSON>\n\n` with a candidates array. The final chunk carries
  // finishReason + usageMetadata. We emit a single complete chunk; pi-ai's
  // parser accepts a single-event stream.
  const res = await fetch(
    `http://localhost:${PORT}/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=AIza-mock&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
    }
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /event-stream/);
  const body = await res.text();
  assert.match(body, /^data: /m);
  assert.match(body, /Sure, happy to help/);
  assert.match(body, /"finishReason":\s*"STOP"/);
});

test("POST /openai/v1/responses emits state-building events pi-ai parser requires", async () => {
  // pi-ai's openai-responses-shared.js parser is state-machine driven:
  //   response.output_item.added  → sets currentItem (must be type=message)
  //   response.content_part.added → pushes part into currentItem.content
  //   response.output_text.delta  → checks currentItem.content[last].type === "output_text",
  //                                 only then extends currentBlock.text
  // Skipping output_item.added or content_part.added means delta events
  // are dropped — exactly the "empty response retries exhausted, payloads=0"
  // failure live CI showed.
  const res = await fetch(`http://localhost:${PORT}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-mock", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /event-stream/);
  const body = await res.text();
  for (const ev of [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.completed",
  ]) {
    assert.match(body, new RegExp(`event: ${ev}`), `missing SSE event "${ev}"`);
  }
  // output_item.added must carry item.type=message with a content array
  assert.match(body, /"type":\s*"message"/);
  // content_part.added must carry part.type=output_text
  assert.match(body, /"type":\s*"output_text"/);
  assert.match(body, /Sure, happy to help/);
});

test("POST /anthropic/v1/messages with stream:true returns SSE event sequence pi-ai parses", async () => {
  // pi-ai's iterateAnthropicEvents (node_modules/.../@earendil-works/pi-ai/dist/providers/anthropic.js)
  // requires these events in order: message_start, content_block_start,
  // content_block_delta, content_block_stop, message_delta, message_stop.
  // Missing message_stop throws "Anthropic stream ended before message_stop".
  const res = await fetch(`http://localhost:${PORT}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": "sk-ant-mock",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /event-stream/);
  const body = await res.text();
  for (const ev of [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]) {
    assert.match(body, new RegExp(`event: ${ev}`), `missing SSE event "${ev}"`);
  }
  assert.match(body, /Sure, happy to help/);
});

test("POST /ollama-cloud/v1/chat/completions with empty body returns 400 (auth passed, body rejected) — validation probe contract", async () => {
  // Pinchy's wizard sends body: "{}" to probe whether the Bearer is valid.
  // 400 means auth passed; 401 means invalid key. This shape MUST hold or
  // wizard validation breaks. See providers.ts:141.
  const res = await fetch(`http://localhost:${PORT}/ollama-cloud/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-ollama-mock", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
});

test("POST /ollama-cloud/v1/chat/completions without Bearer returns 401", async () => {
  const res = await fetch(`http://localhost:${PORT}/ollama-cloud/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("POST /ollama-cloud/v1/chat/completions with proper messages returns OpenAI-shaped response", async () => {
  const res = await fetch(`http://localhost:${PORT}/ollama-cloud/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-ollama-mock", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-next:80b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.role, "assistant");
  assert.ok(body.choices[0].message.content.length > 0);
});
