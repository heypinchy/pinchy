// packages/web/src/__tests__/lib/fake-ollama-ref-dispatch.test.ts
//
// Unit coverage for the fake-LLM's DYNAMIC ref-resolution primitive (pinchy#791).
//
// A `_pinchy_ref` is an AES-GCM token minted at runtime (per connection, per
// record), so a statically-scripted tool call can never carry a valid one. The
// harness instead behaves like a real model: it first calls odoo_read, then
// reads the real `_pinchy_ref` back out of that tool-result message and reuses
// it in the ref-based tool. These two pure helpers are that logic, unit-tested
// here so the E2E spec only has to prove the wiring, not the parsing.
import { describe, expect, it } from "vitest";
import {
  extractPinchyRefFromToolResults,
  buildOdooRefDispatchScript,
  FAKE_OLLAMA_ODOO_SCHEDULE_ACTIVITY_REF_RESPONSE,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

const REF = "pinchy_ref:v1:AbCd-1234_efGH";

function toolResult(records: Array<Record<string, unknown>>): Record<string, unknown> {
  return { role: "tool", content: JSON.stringify({ records }) };
}

describe("extractPinchyRefFromToolResults", () => {
  it("returns null when there is no tool-result message", () => {
    expect(extractPinchyRefFromToolResults([{ role: "user", content: "hi" }])).toBeNull();
  });

  it("extracts a _pinchy_ref token from a tool-result message", () => {
    const messages = [
      { role: "user", content: "E2E trigger" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "odoo_read" } }] },
      toolResult([{ id: 5, name: "Acme Lead", _pinchy_ref: REF }]),
    ];
    expect(extractPinchyRefFromToolResults(messages)).toBe(REF);
  });

  it("ignores a stale ref from before the last user message (current round only)", () => {
    const stale = "pinchy_ref:v1:STALE_from_prior_round";
    const messages = [
      { role: "user", content: "old turn" },
      toolResult([{ id: 1, _pinchy_ref: stale }]),
      { role: "user", content: "E2E trigger" }, // new round starts here
      { role: "assistant", content: "", tool_calls: [{ function: { name: "odoo_read" } }] },
      toolResult([{ id: 5, _pinchy_ref: REF }]),
    ];
    expect(extractPinchyRefFromToolResults(messages)).toBe(REF);
  });

  it("reads content delivered as an OpenAI parts array", () => {
    const messages = [
      { role: "user", content: "E2E trigger" },
      {
        role: "tool",
        content: [{ type: "text", text: JSON.stringify({ _pinchy_ref: REF }) }],
      },
    ];
    expect(extractPinchyRefFromToolResults(messages)).toBe(REF);
  });
});

describe("buildOdooRefDispatchScript", () => {
  const trigger = { role: "user", content: "E2E_ODOO_SCHEDULE_ACTIVITY_REF: follow up" };

  it("round 1 (no tool results yet): reads crm.lead to obtain a real ref", () => {
    const script = buildOdooRefDispatchScript([trigger]);
    expect(script.kind).toBe("tool");
    if (script.kind !== "tool") throw new Error("unreachable");
    expect(script.toolName).toBe("odoo_read");
    expect(script.arguments.model).toBe("crm.lead");
  });

  it("round 2 (one read result): schedules an activity on the returned ref", () => {
    const messages = [
      trigger,
      { role: "assistant", content: "", tool_calls: [{ function: { name: "odoo_read" } }] },
      toolResult([{ id: 5, name: "Acme Lead", _pinchy_ref: REF }]),
    ];
    const script = buildOdooRefDispatchScript(messages);
    expect(script.kind).toBe("tool");
    if (script.kind !== "tool") throw new Error("unreachable");
    expect(script.toolName).toBe("odoo_schedule_activity");
    expect(script.arguments.target).toBe(REF);
    expect(typeof script.arguments.summary).toBe("string");
    expect(script.arguments.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("round 2 with no ref in the read result: surfaces the harness failure as text", () => {
    const messages = [
      trigger,
      { role: "assistant", content: "", tool_calls: [{ function: { name: "odoo_read" } }] },
      { role: "tool", content: JSON.stringify({ records: [] }) },
    ];
    const script = buildOdooRefDispatchScript(messages);
    expect(script.kind).toBe("text");
    if (script.kind !== "text") throw new Error("unreachable");
    expect(script.text).toMatch(/_pinchy_ref/);
  });

  it("round 3 (activity scheduled): returns the final completion text", () => {
    const messages = [
      trigger,
      { role: "assistant", content: "", tool_calls: [{ function: { name: "odoo_read" } }] },
      toolResult([{ id: 5, _pinchy_ref: REF }]),
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "odoo_schedule_activity" } }],
      },
      { role: "tool", content: JSON.stringify({ id: 99 }) },
    ];
    const script = buildOdooRefDispatchScript(messages);
    expect(script.kind).toBe("text");
    if (script.kind !== "text") throw new Error("unreachable");
    expect(script.text).toBe(FAKE_OLLAMA_ODOO_SCHEDULE_ACTIVITY_REF_RESPONSE);
  });
});
