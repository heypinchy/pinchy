import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIRM_TTL_MS } from "@/lib/approvals/service";

/**
 * Two clocks run on one confirmation and neither knows about the other:
 *
 *  - OpenClaw parks the tool call for `requireApproval.timeoutMs`, hard-capped
 *    at `MAX_PLUGIN_APPROVAL_TIMEOUT_MS` (600 s in 2026.4.27). Past it the call
 *    is resolved as a timeout and the approval is gone.
 *  - Pinchy's row lives for {@link DEFAULT_CONFIRM_TTL_MS}, and the inbox shows
 *    a card for as long as the row is unexpired.
 *
 * A row that outlives the parked call is a card the user can still click over a
 * run that has already given up. That is not merely cosmetic: they click
 * approve, and whether they learn the tool never ran depends entirely on the
 * resume path reporting it. Keeping the two equal removes the window.
 *
 * The plugin value is read as TEXT rather than imported: `packages/web` must not
 * pull a plugin module into its build graph (AGENTS.md § "The Pre-Push Build …"),
 * and this only needs to compare two numbers.
 */
const GATE_TS = path.join(process.cwd(), "../plugins/pinchy-approvals/gate.ts");

function pluginApprovalTimeoutMs(): number {
  const source = readFileSync(GATE_TS, "utf8");
  const match = /APPROVAL_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(source);
  // Throw rather than skip: a renamed constant must fail loudly here, not make
  // this guard quietly stop comparing anything.
  if (!match) throw new Error(`No APPROVAL_TIMEOUT_MS found in ${GATE_TS}`);
  return Number(match[1].replaceAll("_", ""));
}

describe("confirmation TTL", () => {
  it("does not outlive the approval OpenClaw is holding", () => {
    expect(DEFAULT_CONFIRM_TTL_MS).toBe(pluginApprovalTimeoutMs());
  });

  // Asking for more than the cap does not extend the wait — OpenClaw clamps it
  // — it only re-opens the same window from the other side.
  it("stays within OpenClaw's hard cap", () => {
    expect(DEFAULT_CONFIRM_TTL_MS).toBeLessThanOrEqual(600_000);
  });
});
