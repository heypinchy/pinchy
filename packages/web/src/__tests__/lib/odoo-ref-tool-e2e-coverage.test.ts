// packages/web/src/__tests__/lib/odoo-ref-tool-e2e-coverage.test.ts
//
// Per-tool E2E-dispatch coverage guard for pinchy-odoo's REF-BASED tools.
//
// Why this exists (pinchy#791): the generic `plugin-tool-coverage` guard is
// satisfied per PLUGIN — one covered tool clears the whole plugin. pinchy-odoo
// passed it on its ref-FREE tools (odoo_read, odoo_create, odoo_list_models)
// while every tool whose primary argument is an opaque runtime-signed
// `_pinchy_ref` shipped with ZERO E2E dispatch coverage. The fake-LLM harness
// could not drive those tools because a `_pinchy_ref` is minted at runtime
// (per connection, per record) and is unknowable when a static trigger is
// authored — so PR #782 (odoo_reconcile) deliberately shipped without an E2E
// test and relied on live Odoo verification instead.
//
// The harness now resolves refs dynamically (the fake-LLM reads the real
// `_pinchy_ref` back from a prior odoo_read tool-result, exactly like a real
// model would — see fake-ollama-ref-dispatch). This guard makes the gap
// un-reopenable: every ref-based odoo tool must be either covered by an E2E
// dispatch test OR carry an explicit, issue-tracked exemption. A NEW ref-based
// tool with neither fails CI here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, PLUGINS_DIR, loadManifest } from "./plugin-tool-extraction";

const ODOO_INDEX = join(PLUGINS_DIR, "pinchy-odoo", "index.ts");

// The authoritative list of pinchy-odoo tools whose primary input is an opaque
// `_pinchy_ref` (target / targetRef / invoice / counterpart). Kept explicit so
// the exemption bookkeeping below is readable; `detectRefToolNames` proves it
// stays in sync with the plugin source in both directions.
const REF_BASED_ODOO_TOOLS = [
  "odoo_schedule_activity",
  "odoo_complete_activity",
  "odoo_reschedule_activity",
  "odoo_confirm_order",
  "odoo_apply_inventory",
  "odoo_validate_picking",
  "odoo_mark_mo_done",
  "odoo_set_approval",
  "odoo_reconcile",
  "odoo_attach_file",
] as const;

// Ref-based odoo tools that do NOT yet have an E2E dispatch test, each with a
// tracked reason. The contract mirrors AGENTS.md's skip/deletion policy: an
// exemption is a deliberate, issue-referenced act, never a silent gap. Every
// reason must cite pinchy#791 (the umbrella issue for closing this backlog).
//
// odoo_reconcile is called out specifically: covering it faithfully needs
// `account.bank.statement.line` / `account.payment` / reconcile semantics in
// the Odoo mock, which real Odoo 19 makes silent-no-op-prone — a mock risks a
// false-green. It stays on live verification until the mock grows that surface.
const PENDING_E2E: Record<string, string> = {
  odoo_complete_activity: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_reschedule_activity: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_confirm_order: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_apply_inventory: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_validate_picking: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_mark_mo_done: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_set_approval: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
  odoo_reconcile:
    "pinchy#791 — needs account.bank.statement.line/account.payment + reconcile " +
    "semantics in the Odoo mock; real Odoo 19 reconcile is silent-no-op-prone, so " +
    "a mock risks a false-green. Stays on live verification until the mock grows it.",
  odoo_attach_file: "pinchy#791 — ref-dispatch harness exists; test not yet written.",
};

/**
 * Derive the ref-based odoo tool names straight from the plugin source, so the
 * explicit list above cannot silently drift when a tool is added or removed.
 * Two shapes carry a `_pinchy_ref` input:
 *   1. `recordActionFactory({ ... name: "odoo_x" ... })` — the shared factory
 *      for record-action tools (confirm_order, validate_picking, …).
 *   2. An inline schema property named target / targetRef / invoice /
 *      counterpart, whose owning tool is the nearest following `name: "odoo_x"`.
 */
function detectRefToolNames(source: string): Set<string> {
  const names = new Set<string>();

  for (const m of source.matchAll(/recordActionFactory\(\{[\s\S]*?name:\s*"(odoo_[a-z_]+)"/g)) {
    names.add(m[1]);
  }

  const refProp = /\b(?:target|targetRef|invoice|counterpart):\s*\{/g;
  for (const m of source.matchAll(refProp)) {
    const after = source.slice(m.index ?? 0);
    const nameMatch = after.match(/name:\s*"(odoo_[a-z_]+)"/);
    if (nameMatch) names.add(nameMatch[1]);
  }

  return names;
}

function walkSpecFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkSpecFiles(fullPath));
    } else if (entry.endsWith(".spec.ts")) {
      result.push(fullPath);
    }
  }
  return result;
}

function getTestedToolsFromE2E(): Set<string> {
  const tested = new Set<string>();
  for (const specFile of walkSpecFiles(E2E_DIR)) {
    const content = readFileSync(specFile, "utf8");
    // Literal audit-log query: /api/audit?eventType=tool.<name>
    for (const match of content.matchAll(/eventType=tool\.([a-z_]+)/g)) {
      tested.add(match[1]);
    }
    // pollAuditForTool(page, { toolName: "<name>", ... })
    for (const match of content.matchAll(/pollAuditForTool\s*\([\s\S]*?toolName:\s*"([a-z_]+)"/g)) {
      tested.add(match[1]);
    }
    // pollAuditForEvent(page, { eventType: "tool.<name>", ... }) — used when the
    // assertion needs the entry itself (e.g. to check outcome=success).
    for (const match of content.matchAll(/eventType:\s*"tool\.([a-z_]+)"/g)) {
      tested.add(match[1]);
    }
  }
  return tested;
}

describe("odoo ref-based tool E2E coverage (pinchy#791)", () => {
  const source = readFileSync(ODOO_INDEX, "utf8");
  const refToolSet = new Set<string>(REF_BASED_ODOO_TOOLS);
  const manifestTools = new Set(loadManifest("pinchy-odoo").contracts?.tools ?? []);
  const testedTools = getTestedToolsFromE2E();

  it("REF_BASED_ODOO_TOOLS matches the ref tools detected in the plugin source", () => {
    const detected = detectRefToolNames(source);
    expect([...detected].sort()).toEqual([...refToolSet].sort());
  });

  it("every listed ref tool is a registered odoo tool (no rename/removal drift)", () => {
    const missing = [...refToolSet].filter((t) => !manifestTools.has(t));
    expect(missing, `ref tools absent from the manifest: ${missing.join(", ")}`).toEqual([]);
  });

  it("every ref tool is either E2E-covered or has a tracked exemption", () => {
    const uncovered = [...refToolSet].filter((t) => !testedTools.has(t) && !(t in PENDING_E2E));
    expect(
      uncovered,
      [
        `Ref-based odoo tools without E2E dispatch coverage or a tracked exemption:`,
        `  ${uncovered.join(", ")}`,
        ``,
        `Add an E2E test (drive odoo_read → reuse the returned _pinchy_ref in the`,
        `ref tool → pollAuditForTool), or add a PENDING_E2E entry citing pinchy#791.`,
      ].join("\n")
    ).toEqual([]);
  });

  it("no exemption is stale (a covered ref tool must be removed from PENDING_E2E)", () => {
    const stale = Object.keys(PENDING_E2E).filter((t) => testedTools.has(t));
    expect(
      stale,
      `these tools are now E2E-covered — delete their PENDING_E2E entry: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("every exemption references a real ref tool and cites the tracking issue", () => {
    for (const [tool, reason] of Object.entries(PENDING_E2E)) {
      expect(refToolSet.has(tool), `${tool} is exempted but not a known ref tool`).toBe(true);
      expect(reason, `${tool}'s exemption must cite pinchy#791`).toMatch(/#791/);
    }
  });

  it("at least one ref tool is genuinely E2E-covered (proves the harness works)", () => {
    const covered = [...refToolSet].filter((t) => testedTools.has(t));
    expect(
      covered.length,
      "no ref-based odoo tool has E2E dispatch coverage — the ref-dispatch harness is unproven"
    ).toBeGreaterThan(0);
  });
});
