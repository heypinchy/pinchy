import { describe, it, expect } from "vitest";
import { enrichToolCallArgs, containsDepthLimitMarker } from "@/lib/diagnostics/enrich-tool-args";
import { sanitizeBundle } from "@/lib/diagnostics/sanitize-bundle";
import type { OtelSpan } from "@/lib/diagnostics/otel-builder";
import type { CollectedAuditEntry } from "@/lib/diagnostics/audit-collector";

// The exact marker OpenClaw's trajectory capture writes when a value is deeper
// than its depth-6 budget. Pinchy passes it through verbatim into spans.
const MARKER = { truncated: true, reason: "trajectory-depth-limit", limitDepth: 6 };

interface Call {
  id: string;
  name: string;
  arguments: unknown;
}

function buildSpan(opts: { start?: number; end?: number; calls: Call[] }): OtelSpan {
  return {
    name: "agent.turn",
    ...(opts.start !== undefined ? { startTime: new Date(opts.start).toISOString() } : {}),
    ...(opts.end !== undefined ? { endTime: new Date(opts.end).toISOString() } : {}),
    attributes: {
      "gen_ai.tool.call.arguments": opts.calls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
    },
  };
}

function auditRow(opts: {
  name: string;
  at: number;
  detail: Record<string, unknown>;
}): CollectedAuditEntry {
  return {
    timestamp: new Date(opts.at),
    eventType: `tool.${opts.name}`,
    actorType: "user",
    actorId: "u1",
    resource: "agent:a1",
    detail: opts.detail,
    outcome: "success",
    error: null,
  };
}

function toolArgs(span: OtelSpan): Array<Record<string, unknown>> {
  return span.attributes["gen_ai.tool.call.arguments"] as Array<Record<string, unknown>>;
}

describe("containsDepthLimitMarker", () => {
  it("detects the marker at the top level", () => {
    expect(containsDepthLimitMarker(MARKER)).toBe(true);
  });

  it("detects the marker nested inside an object/array", () => {
    expect(containsDepthLimitMarker({ model: "res.partner", values: MARKER })).toBe(true);
    expect(containsDepthLimitMarker({ a: { b: [1, { c: MARKER }] } })).toBe(true);
  });

  it("returns false for fully-resolved arguments", () => {
    expect(containsDepthLimitMarker({ model: "res.partner", values: { name: "x" } })).toBe(false);
    expect(containsDepthLimitMarker(null)).toBe(false);
    expect(containsDepthLimitMarker("plain")).toBe(false);
  });
});

describe("enrichToolCallArgs", () => {
  it("replaces a nested depth-limit marker with full audit params and marks argsSource=audit", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [
        { id: "tc1", name: "odoo_create", arguments: { model: "res.partner", values: MARKER } },
      ],
    });
    const fullParams = {
      model: "res.partner",
      values: { name: "Acme", child_ids: [[0, 0, { name: "Contact" }]] },
    };
    const audit = [
      auditRow({
        name: "odoo_create",
        at: 1500,
        detail: { toolName: "odoo_create", success: true, params: fullParams },
      }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("audit");
    expect(arg.arguments).toEqual(fullParams);
  });

  it("replaces arguments that are themselves the marker", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "odoo_read", arguments: MARKER }],
    });
    const fullParams = { model: "res.partner", filters: [["is_company", "=", true]] };
    const audit = [auditRow({ name: "odoo_read", at: 1500, detail: { params: fullParams } })];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("audit");
    expect(arg.arguments).toEqual(fullParams);
  });

  it("keeps the marker (argsSource=trajectory) when no matching audit row exists", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "odoo_create", arguments: { values: MARKER } }],
    });
    // Wrong tool name -> not a candidate.
    const audit = [auditRow({ name: "odoo_read", at: 1500, detail: { params: { model: "x" } } })];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("trajectory");
    expect(arg.arguments).toEqual({ values: MARKER });
  });

  it("keeps the marker when the audit row is outside the span time window", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "odoo_create", arguments: { values: MARKER } }],
    });
    const audit = [
      auditRow({ name: "odoo_create", at: 9999, detail: { params: { values: { real: true } } } }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("trajectory");
    expect(arg.arguments).toEqual({ values: MARKER });
  });

  it("keeps the marker when the audit row itself was byte-cap truncated (no params)", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "odoo_create", arguments: { values: MARKER } }],
    });
    const audit = [
      auditRow({
        name: "odoo_create",
        at: 1500,
        detail: { _truncated: true, _originalSize: 5000, summary: '{"toolName":"odoo_create",...' },
      }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("trajectory");
    expect(arg.arguments).toEqual({ values: MARKER });
  });

  it("leaves fully-resolved trajectory arguments untouched and marks them trajectory", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "docs_list", arguments: { q: "hello" } }],
    });
    const audit = [
      auditRow({ name: "docs_list", at: 1500, detail: { params: { q: "SHOULD-NOT-WIN" } } }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("trajectory");
    expect(arg.arguments).toEqual({ q: "hello" });
  });

  it("aligns multiple same-tool calls positionally when counts match (n === m)", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [
        { id: "tc1", name: "odoo_create", arguments: { seq: 1, values: MARKER } },
        { id: "tc2", name: "odoo_create", arguments: { seq: 2, values: MARKER } },
      ],
    });
    const audit = [
      auditRow({
        name: "odoo_create",
        at: 1200,
        detail: { params: { seq: 1, values: { first: true } } },
      }),
      auditRow({
        name: "odoo_create",
        at: 1400,
        detail: { params: { seq: 2, values: { second: true } } },
      }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const args = toolArgs(out);
    expect(args[0].argsSource).toBe("audit");
    expect(args[0].arguments).toEqual({ seq: 1, values: { first: true } });
    expect(args[1].argsSource).toBe("audit");
    expect(args[1].arguments).toEqual({ seq: 2, values: { second: true } });
  });

  it("does not guess when same-tool call/candidate counts differ (n !== m)", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [
        { id: "tc1", name: "odoo_create", arguments: { seq: 1, values: MARKER } },
        { id: "tc2", name: "odoo_create", arguments: { seq: 2, values: MARKER } },
      ],
    });
    // Only one audit candidate for two calls -> ambiguous -> keep both markers.
    const audit = [
      auditRow({ name: "odoo_create", at: 1200, detail: { params: { values: { only: true } } } }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const args = toolArgs(out);
    expect(args[0].argsSource).toBe("trajectory");
    expect(args[0].arguments).toEqual({ seq: 1, values: MARKER });
    expect(args[1].argsSource).toBe("trajectory");
    expect(args[1].arguments).toEqual({ seq: 2, values: MARKER });
  });

  it("uses exact toolCallId matching when the audit detail carries one (order-independent)", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [
        { id: "tc1", name: "odoo_create", arguments: { seq: 1, values: MARKER } },
        { id: "tc2", name: "odoo_create", arguments: { seq: 2, values: MARKER } },
      ],
    });
    // Audit rows arrive in reverse order but carry toolCallId -> match by id, not position.
    const audit = [
      auditRow({
        name: "odoo_create",
        at: 1400,
        detail: { toolCallId: "tc2", params: { seq: 2, ok: "two" } },
      }),
      auditRow({
        name: "odoo_create",
        at: 1600,
        detail: { toolCallId: "tc1", params: { seq: 1, ok: "one" } },
      }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const args = toolArgs(out);
    expect(args[0].arguments).toEqual({ seq: 1, ok: "one" });
    expect(args[1].arguments).toEqual({ seq: 2, ok: "two" });
  });

  it("keeps markers for spans without timestamps (cannot scope audit rows)", () => {
    const span = buildSpan({
      calls: [{ id: "tc1", name: "odoo_create", arguments: { values: MARKER } }],
    });
    const audit = [
      auditRow({ name: "odoo_create", at: 1500, detail: { params: { values: { real: true } } } }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("trajectory");
    expect(arg.arguments).toEqual({ values: MARKER });
  });

  it("keeps secret redaction on enriched params through the sanitize step (pipeline order)", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "http_call", arguments: { config: MARKER } }],
    });
    const audit = [
      auditRow({
        name: "http_call",
        at: 1500,
        detail: { params: { config: { apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" } } },
      }),
    ];

    const enriched = enrichToolCallArgs([span], audit);
    // Route order: enrich -> sanitizeBundle -> size cap. Secret must be gone.
    const sanitized = sanitizeBundle({ spans: enriched });
    const arg = (
      sanitized.spans[0].attributes["gen_ai.tool.call.arguments"] as Array<Record<string, unknown>>
    )[0];
    expect(arg.argsSource).toBe("audit");
    const config = (arg.arguments as { config: { apiKey: string } }).config;
    expect(config.apiKey).toBe("[REDACTED]");
  });

  it("redacts a deeply-nested secret in enriched params at inject time (bundle-depth-independent)", () => {
    // In the bundle the enriched arguments already sit ~6 levels deep, so the
    // bundle-level sanitize's depth-10 guard barely reaches inside them. This
    // secret sits deeper than that guard alone would scrub, so enrichment must
    // re-scrub the params from their own root — the redaction here proves it
    // does NOT depend on a later sanitizeBundle pass.
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "http_call", arguments: { a: MARKER } }],
    });
    const audit = [
      auditRow({
        name: "http_call",
        at: 1500,
        detail: {
          params: { a: { b: { c: { d: { apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" } } } } },
        },
      }),
    ];

    const [out] = enrichToolCallArgs([span], audit);
    const arg = toolArgs(out)[0];
    expect(arg.argsSource).toBe("audit");
    const leaf = arg.arguments as { a: { b: { c: { d: { apiKey: string } } } } };
    expect(leaf.a.b.c.d.apiKey).toBe("[REDACTED]");
  });

  it("does not mutate the source audit entry's params when injecting", () => {
    const span = buildSpan({
      start: 1000,
      end: 2000,
      calls: [{ id: "tc1", name: "http_call", arguments: { config: MARKER } }],
    });
    const params = { config: { apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" } };
    const audit = [auditRow({ name: "http_call", at: 1500, detail: { params } })];

    enrichToolCallArgs([span], audit);
    // Redaction happens on a copy; the audit row we read from stays intact.
    expect(params.config.apiKey).toBe("sk-ant-abcdefghijklmnopqrstuvwxyz012345");
  });
});
