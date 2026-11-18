import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildToolProbeRequest,
  buildToolFollowupRequest,
  buildNestedToolProbeRequest,
  classifyToolResponse,
  classifyNestedToolResponse,
  isTransientStatus,
} from "./ollama-cloud-tool-probe.mjs";

// Helper: wrap `arguments` the way the API does — a JSON *string*.
function nestedResponse(args, name = "search_records") {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name,
                arguments:
                  typeof args === "string" ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

const CLEAN_NESTED_ARGS = {
  model: "account.move",
  filters: [
    ["state", "=", "posted"],
    ["amount", ">", 10],
  ],
  fields: ["name", "amount"],
};

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

// ---------------------------------------------------------------------------
// Round 3: the nested-argument probe.
//
// minimax-m3 passes the flat get_weather probe cleanly but mangles NESTED
// arrays: they collapse into {"item": …} objects and some arrive stringified
// ("[10, 20]"). In production (2026-07-15, agent "Penny") that broke Odoo
// domain filters ("unhashable type: 'dict'") and account.move command
// triplets — 20 of 60 tool calls mangled, vs 0/112 on kimi-k2.6 and 0/68 on
// deepseek-v4-pro. A flat schema cannot see this defect class at all.
// ---------------------------------------------------------------------------

test("buildNestedToolProbeRequest declares a tool whose schema requires an array of arrays", () => {
  const body = buildNestedToolProbeRequest("minimax-m3");
  assert.equal(body.model, "minimax-m3");
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1);

  const fn = body.tools[0].function;
  assert.equal(body.tools[0].type, "function");
  assert.equal(fn.name, "search_records");

  const props = fn.parameters.properties;
  assert.equal(props.model.type, "string");
  // The load-bearing bit: filters is array-of-arrays, shaped like an Odoo
  // domain. If this ever flattens to a plain array of strings, the probe stops
  // testing the thing it exists to test.
  assert.equal(props.filters.type, "array");
  assert.equal(props.filters.items.type, "array");
  assert.equal(props.fields.type, "array");
  assert.equal(props.fields.items.type, "string");
  assert.deepEqual(fn.parameters.required, ["model", "filters", "fields"]);

  // A user turn concrete enough to pin the expected domain, and bounded cost.
  // The ceiling is deliberately roomier than the flat probe's: a thinking model
  // spends budget before it ever emits the call, and a truncated call would be
  // reported as a capability defect it doesn't have.
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /posted/i);
  assert.ok(body.max_tokens >= 512 && body.max_tokens <= 1024);
});

test("genuine nested arrays with named arguments pass the nested probe", () => {
  const result = classifyNestedToolResponse(nestedResponse(CLEAN_NESTED_ARGS));
  assert.equal(result.nestedOk, true);
  assert.equal(result.failure, null);
});

test("no tool_call at all fails the nested probe", () => {
  const result = classifyNestedToolResponse({
    choices: [
      { message: { content: "Sure, I'll look that up.", tool_calls: [] } },
    ],
  });
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "no-tool-call");
});

test("arguments that are not valid JSON fail the nested probe", () => {
  const result = classifyNestedToolResponse(
    nestedResponse("{model: account.move,"),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "unparseable-arguments");
});

test('an {"item": …} wrapper around the filters array is the minimax-m3 defect', () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: { item: [["state", "=", "posted"]] },
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "item-wrapper");
  assert.match(result.detail, /filters/);
});

test('an {"item": …} wrapper around an inner domain triplet is caught too', () => {
  // The outer array survives, each triplet collapses into a dict — this is the
  // exact shape behind Odoo's "unhashable type: 'dict'".
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [
        { item: ["state", "=", "posted"] },
        { item: ["amount", ">", 10] },
      ],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "item-wrapper");
  assert.match(result.detail, /filters\[0\]/);
});

test("a stringified filters array fails even though it parses back to an array", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: '[["state", "=", "posted"]]',
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "stringified-array");
});

test('a stringified array nested inside a domain triplet fails (the "[10, 20]" defect)', () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [["amount", "in", "[10, 20]"]],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "stringified-array");
  assert.match(result.detail, /\[10, 20\]/);
});

test("a stringified fields array fails", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({ ...CLEAN_NESTED_ARGS, fields: '["name", "amount"]' }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "stringified-array");
  assert.match(result.detail, /fields/);
});

test("positional arguments fail even when the nesting itself is intact", () => {
  const result = classifyNestedToolResponse(
    nestedResponse(["account.move", [["state", "=", "posted"]], ["name"]]),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "positional-arguments");
});

test("named arguments faked with numeric keys are still positional", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      0: "account.move",
      1: [["state", "=", "posted"]],
      2: ["name"],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "positional-arguments");
});

test("a missing required argument fails the nested probe", () => {
  const { filters: _dropped, ...withoutFilters } = CLEAN_NESTED_ARGS;
  const result = classifyNestedToolResponse(nestedResponse(withoutFilters));
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-shape");
  assert.match(result.detail, /filters/);
});

test("a flat filters array (strings, not triplets) fails the nested probe", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({ ...CLEAN_NESTED_ARGS, filters: ["state", "=", "posted"] }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-shape");
});

test("a list value inside a triplet is legitimate nesting, not a defect", () => {
  // ["state", "in", ["posted", "draft"]] is a perfectly valid Odoo domain: the
  // deepest correct nesting a model can produce. Rejecting it would fail the
  // very models this probe exists to keep.
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [["state", "in", ["posted", "draft"]]],
    }),
  );
  assert.equal(result.nestedOk, true);
  assert.equal(result.failure, null);
});

test("a stringified array inside a triplet's list value still fails", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [["amount", "in", ["[10, 20]"]]],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "stringified-array");
  assert.match(result.detail, /filters\[0\]\[2\]\[0\]/);
});

test("an item wrapper inside a triplet's list value still fails", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [["state", "in", [{ item: "posted" }]]],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "item-wrapper");
});

test("a triplet member nested deeper than a list value is the wrong shape", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: [["state", "in", [["posted"]]]],
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-shape");
});

test('an {"items": …} wrapper is caught like the {"item": …} one', () => {
  const result = classifyNestedToolResponse(
    nestedResponse({
      ...CLEAN_NESTED_ARGS,
      filters: { items: [["state", "=", "posted"]] },
    }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "item-wrapper");
  assert.match(result.detail, /items/);
});

test("calling a tool the probe never offered is reported as such, not as bad arguments", () => {
  // Misattributing this as wrong-shape would make the probe lie about the
  // defect class, which is the one thing it produces.
  const result = classifyNestedToolResponse(
    nestedResponse({ city: "Paris" }, "get_weather"),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-tool");
  assert.match(result.detail, /get_weather/);
});

test("a non-string field reports that a string was expected, not an array", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({ ...CLEAN_NESTED_ARGS, fields: ["name", 42] }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-shape");
  assert.match(result.detail, /fields\[1\].*expected a string/);
});

test("a field that is an array reports the wrong shape against a string", () => {
  const result = classifyNestedToolResponse(
    nestedResponse({ ...CLEAN_NESTED_ARGS, fields: [["name"]] }),
  );
  assert.equal(result.nestedOk, false);
  assert.equal(result.failure, "wrong-shape");
  assert.match(result.detail, /expected a string/);
});

test("arguments already parsed into an object (not a JSON string) are accepted", () => {
  // Some gateways hand back `arguments` pre-parsed; that is not a defect.
  const result = classifyNestedToolResponse({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "search_records",
                arguments: CLEAN_NESTED_ARGS,
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(result.nestedOk, true);
});
