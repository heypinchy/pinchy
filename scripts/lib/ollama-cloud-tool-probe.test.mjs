import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildToolProbeRequest,
  buildToolFollowupRequest,
  classifyToolResponse,
  isTransientStatus,
} from "./ollama-cloud-tool-probe.mjs";

test("isTransientStatus flags retriable infra errors, not capability verdicts", () => {
  // 429/5xx are infra noise → retry, never report as "model lost tools".
  for (const s of [429, 500, 502, 503, 504]) {
    assert.equal(isTransientStatus(s), true, `${s} should be transient`);
  }
  // 200 = success, 400 = capability error, 404 = model gone — all definitive.
  for (const s of [200, 400, 404]) {
    assert.equal(isTransientStatus(s), false, `${s} should be definitive`);
  }
});

test("buildToolProbeRequest offers one function tool and a prompt that needs it", () => {
  const body = buildToolProbeRequest("glm-5.2");
  assert.equal(body.model, "glm-5.2");
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "get_weather");
  // A real user turn that should provoke the call.
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /weather/i);
  // Bounded so the probe is cheap.
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 256);
});

test("buildToolFollowupRequest echoes the tool_call and feeds back a tool result", () => {
  // The multi-turn round is what catches gemma3 / kimi-k2-thinking: those emit
  // a clean single-turn tool_call but HTTP 500 once the history carries a tool
  // result. The follow-up must replay the assistant tool_call and answer it.
  const assistantMessage = {
    content: "",
    tool_calls: [
      {
        id: "call_abc123",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ],
  };
  const body = buildToolFollowupRequest("glm-5.2", assistantMessage);
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[1].role, "assistant");
  assert.deepEqual(body.messages[1].tool_calls, assistantMessage.tool_calls);
  assert.equal(body.messages[2].role, "tool");
  assert.equal(body.messages[2].tool_call_id, "call_abc123");
  assert.match(body.messages[2].content, /\S/); // non-empty tool result
});

test("a structured tool_calls response counts as tool-capable", () => {
  const result = classifyToolResponse({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(result.supportsTools, true);
  assert.equal(result.leakedAsText, false);
});

test("empty content with no tool_calls is NOT tool-capable (qwen3-next failure mode)", () => {
  const result = classifyToolResponse({
    choices: [{ message: { content: "", tool_calls: [] } }],
  });
  assert.equal(result.supportsTools, false);
  assert.equal(result.leakedAsText, false);
});

test("a tool call leaked as plain text is flagged, not counted as capable (gemini-3 default_api)", () => {
  const result = classifyToolResponse({
    choices: [
      {
        message: {
          content:
            "I'll check that for you.\ndefault_api.get_weather(city='Paris')",
        },
      },
    ],
  });
  assert.equal(result.supportsTools, false);
  assert.equal(result.leakedAsText, true);
});

test("an XML-style <tool_call> blob in content is also a leak", () => {
  const result = classifyToolResponse({
    choices: [
      {
        message: {
          content: '<tool_call>{"name": "get_weather"}</tool_call>',
        },
      },
    ],
  });
  assert.equal(result.supportsTools, false);
  assert.equal(result.leakedAsText, true);
});

test("a plain prose answer with no call and no leak is just not tool-capable here", () => {
  const result = classifyToolResponse({
    choices: [{ message: { content: "It is sunny in Paris today." } }],
  });
  assert.equal(result.supportsTools, false);
  assert.equal(result.leakedAsText, false);
});
