// #723: governed-tools comparison sweep — harness plumbing for the
// governed/ungoverned toggle. These are the pure helpers the sweep and the
// offline re-grader/exporter share; the Playwright spec (eval-models.spec.ts)
// wires them but is itself covered by the probe run, not unit tests.
//
// Semantics, kept identical to the plugin's governanceEnforced() so the harness
// label can never disagree with what the plugin actually did:
//   - PINCHY_ODOO_GOVERNANCE unset/anything-but-"off"  => "enforced"
//   - exactly "off" (case-insensitive, trimmed)        => "off"
// Label scheme (design decision D2 = frozen baseline): the plugin is now
// governed BY DEFAULT, so a default sweep produces GOVERNED data and must not
// overwrite the frozen ungoverned Eval-v1 baseline that lives under the plain
// label. Hence enforced => "<label>-governed"; off => the plain "<label>".
import { describe, it, expect, vi, afterEach } from "vitest";
import { governanceModeFromEnv, governedScorecardLabel, governanceFromLabel } from "../run-eval";
import { governanceOfRun } from "../../src/lib/eval/scorecard";
import { scenarioForLabel } from "../regrade";
import { hetznerInvoiceDuplicateScenario } from "../scenarios/hetzner-invoice-duplicate";
import type { RunResult } from "../../src/lib/eval/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("governanceModeFromEnv", () => {
  it('defaults to "enforced" when PINCHY_ODOO_GOVERNANCE is unset', () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "");
    expect(governanceModeFromEnv()).toBe("enforced");
  });

  it('is "off" only for the exact literal "off" (case-insensitive, trimmed)', () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "off");
    expect(governanceModeFromEnv()).toBe("off");
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "OFF");
    expect(governanceModeFromEnv()).toBe("off");
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "  off  ");
    expect(governanceModeFromEnv()).toBe("off");
  });

  it('fails safe to "enforced" on any unrecognized value', () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "disabled");
    expect(governanceModeFromEnv()).toBe("enforced");
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "enforced");
    expect(governanceModeFromEnv()).toBe("enforced");
  });
});

describe("governedScorecardLabel", () => {
  it('suffixes "-governed" for the enforced arm', () => {
    expect(governedScorecardLabel("hetzner-invoice-duplicate-models", "enforced")).toBe(
      "hetzner-invoice-duplicate-models-governed"
    );
  });

  it("keeps the plain label for the ungoverned arm (frozen baseline)", () => {
    expect(governedScorecardLabel("hetzner-invoice-duplicate-models", "off")).toBe(
      "hetzner-invoice-duplicate-models"
    );
  });

  it("is idempotent — never double-suffixes an already-governed label", () => {
    expect(governedScorecardLabel("hetzner-invoice-duplicate-models-governed", "enforced")).toBe(
      "hetzner-invoice-duplicate-models-governed"
    );
  });
});

describe("governanceFromLabel (inverse — used by regrade + export)", () => {
  it('reads "-governed" suffix as the enforced arm', () => {
    expect(governanceFromLabel("hetzner-invoice-duplicate-models-governed")).toBe("enforced");
  });

  it("reads a plain label as the ungoverned arm", () => {
    expect(governanceFromLabel("hetzner-invoice-duplicate-models")).toBe("off");
  });
});

describe("scenarioForLabel (regrade resolves both arms to one scenario)", () => {
  it("resolves a plain (ungoverned) label", () => {
    expect(scenarioForLabel("hetzner-invoice-duplicate-models")).toBe(
      hetznerInvoiceDuplicateScenario
    );
  });

  it("resolves a -governed label to the SAME scenario object", () => {
    expect(scenarioForLabel("hetzner-invoice-duplicate-models-governed")).toBe(
      hetznerInvoiceDuplicateScenario
    );
  });

  it("returns undefined for an unknown label", () => {
    expect(scenarioForLabel("not-a-scenario")).toBeUndefined();
  });
});

describe("governanceOfRun (grandfathering: absence = ungoverned baseline)", () => {
  const base: RunResult = {
    model: "kimi-k2.6",
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 1,
  };

  it("returns the stamped mode when present", () => {
    expect(governanceOfRun({ ...base, governance: "enforced" })).toBe("enforced");
    expect(governanceOfRun({ ...base, governance: "off" })).toBe("off");
  });

  it('treats a row with no governance field as "off" (pre-guard Eval-v1 baseline)', () => {
    expect(governanceOfRun(base)).toBe("off");
  });
});
