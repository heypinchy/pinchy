import { describe, it, expect } from "vitest";

import { AUTOMATION_MAX_CONNECTIONS, createAutomationSchema } from "@/lib/schemas/automations";

// The shared request schema for POST /api/automations. Both the route handler
// (parseRequestBody) and — later — the client form / the conversational
// create tool (#705) import it, so a drift between what a caller sends and what
// the route accepts is a compile-time error, not a runtime 400 (AGENTS.md,
// "Shared Schemas And Typed Client").
describe("createAutomationSchema", () => {
  const valid = {
    agentId: "agent-1",
    name: "File supplier invoices",
    filter: { hasAttachment: true, attachmentType: "application/pdf" },
    action: "Draft a supplier bill in Odoo from the attached invoice.",
    connectionIds: ["conn-1"],
    sweepWindowDays: 30,
  };

  it("parses a fully specified workflow", () => {
    const parsed = createAutomationSchema.parse(valid);
    expect(parsed).toMatchObject(valid);
  });

  it("defaults filter to an empty matcher and sweepWindowDays to 14", () => {
    // A caller may omit the filter (watch a whole mailbox) and the cadence knob;
    // the route must still receive concrete values to write, so the defaults
    // live in the schema, not scattered across callers.
    const parsed = createAutomationSchema.parse({
      agentId: "agent-1",
      name: "Watch the invoices mailbox",
      action: "File whatever lands here.",
      connectionIds: ["conn-1"],
    });
    expect(parsed.filter).toEqual({});
    expect(parsed.sweepWindowDays).toBe(14);
  });

  it("requires at least one connection — a workflow with no mailbox is inert", () => {
    const result = createAutomationSchema.safeParse({ ...valid, connectionIds: [] });
    expect(result.success).toBe(false);
  });

  it("caps connectionIds — an absurd list must not balloon the error echo or audit detail", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `conn-${i}`);
    expect(
      createAutomationSchema.safeParse({
        ...valid,
        connectionIds: ids(AUTOMATION_MAX_CONNECTIONS),
      }).success
    ).toBe(true);
    expect(
      createAutomationSchema.safeParse({
        ...valid,
        connectionIds: ids(AUTOMATION_MAX_CONNECTIONS + 1),
      }).success
    ).toBe(false);
  });

  it("rejects a blank or whitespace-only name", () => {
    expect(createAutomationSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("requires an agent and a non-empty action", () => {
    expect(createAutomationSchema.safeParse({ ...valid, agentId: "" }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...valid, action: "" }).success).toBe(false);
  });

  it("rejects a non-positive or non-integer sweep window", () => {
    expect(createAutomationSchema.safeParse({ ...valid, sweepWindowDays: 0 }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...valid, sweepWindowDays: -1 }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...valid, sweepWindowDays: 2.5 }).success).toBe(
      false
    );
  });
});
