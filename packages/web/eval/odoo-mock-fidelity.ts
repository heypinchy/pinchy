// packages/web/eval/odoo-mock-fidelity.ts
//
// Behavioral guard against a STALE odoo-mock image (pinchy#1165).
//
// The frozen 2026-07-13 line-items baseline was captured against an odoo-mock
// container whose IMAGE predated the many2one write-validation fix (#615,
// 2026-07-08) even though the source tree already carried it: `docker compose
// up` without `--build` reused the older image. That stale mock silently
// credited `account.move.line` creates whose `account_id` was an unresolvable
// STRING (e.g. "Expense Account", "600000") — writes the faithful mock, and
// real Odoo, both reject. The result was a spurious −13pp "regression" in the
// #723 governed comparison and a contaminated published baseline.
//
// The runbook already prescribes `--build` (run-model-eval SKILL, iron rule 4),
// but prose can be forgotten. This guard makes it impossible for a stale mock to
// silently produce data: at sweep start it POSTs one deliberately-invalid create
// to the mock's JSON-RPC endpoint and ABORTS the sweep unless the mock rejects
// it. It tests the real wire path (HTTP -> execute_kw -> validateMany2OneValues),
// so it catches any unfaithful mock — stale image, wrong image, or misbuild —
// not merely a known-missing code marker.
//
// A rejected create materializes no record, so the probe is non-mutating on a
// faithful mock (the only mock a sweep is allowed to proceed against).

/**
 * A display-name string that resolves to no account in any seeded eval catalog.
 * A faithful mock rejects it (many2one expects an id); a stale mock credits it.
 */
export const FIDELITY_PROBE_ACCOUNT_ID = "__pinchy_fidelity_probe_not_an_account__";

/**
 * The Odoo JSON-RPC `execute_kw` body that creates an `account.move.line` with a
 * non-resolvable STRING `account_id`. Auth args are dummies — the mock's
 * execute_kw path does not verify credentials (only `common/authenticate` does),
 * matching how the real plugin's create reaches `validateMany2OneValues` first.
 */
export function buildFidelityProbeBody(): unknown {
  return {
    jsonrpc: "2.0",
    method: "call",
    id: 1,
    params: {
      service: "object",
      method: "execute_kw",
      args: [
        "eval",
        1,
        "eval",
        "account.move.line",
        "create",
        [{ account_id: FIDELITY_PROBE_ACCOUNT_ID }],
      ],
    },
  };
}

/**
 * The mock's JSON-RPC endpoint as seen from the HOST. The plugin (in-container)
 * reaches it at `odoo-mock:8069`; the eval compose maps that to `localhost:8169`
 * (docker-compose.eval.yml). The eval npm scripts set `MOCK_ODOO_JSONRPC_URL`
 * explicitly, mirroring how they set `MOCK_ODOO_URL` for the control server.
 */
export function resolveOdooMockJsonRpcUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return env.MOCK_ODOO_JSONRPC_URL || "http://localhost:8169/jsonrpc";
}

export interface FidelityVerdict {
  faithful: boolean;
  reason: string;
}

/**
 * Classify the mock's JSON-RPC response to the probe. Fails closed: anything
 * that is not an explicit validation error is treated as unfaithful, because a
 * sweep that proceeds against a silently-permissive mock is exactly the failure
 * this guard exists to prevent.
 */
export function interpretFidelityProbe(response: unknown): FidelityVerdict {
  if (!response || typeof response !== "object") {
    return { faithful: false, reason: "non-object JSON-RPC response" };
  }
  const r = response as { error?: unknown; result?: unknown };
  if (r.error) {
    return { faithful: true, reason: "mock rejected the invalid many2one (faithful)" };
  }
  if (typeof r.result === "number") {
    return {
      faithful: false,
      reason: `mock ACCEPTED the string account_id and created record id=${r.result} — the many2one validation (#615) is not active`,
    };
  }
  return {
    faithful: false,
    reason: "unexpected JSON-RPC response shape (neither a validation error nor a create id)",
  };
}

/**
 * Assert the odoo-mock at `jsonRpcUrl` enforces many2one validation. Throws a
 * descriptive, actionable error (with remediation + #1165) when it does not, or
 * when the endpoint is unreachable. Resolves silently against a faithful mock.
 */
export async function assertOdooMockEnforcesMany2One(
  jsonRpcUrl: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: unknown;
  try {
    const res = await fetchImpl(jsonRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFidelityProbeBody()),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    response = await res.json();
  } catch (err) {
    throw new Error(
      `[eval] could not reach the odoo-mock JSON-RPC endpoint at ${jsonRpcUrl} to verify ` +
        `many2one fidelity: ${err instanceof Error ? err.message : String(err)}. Is the eval ` +
        `stack up? (MOCK_ODOO_JSONRPC_URL maps to the mock's 8069 port, e.g. localhost:8169.)`
    );
  }

  const verdict = interpretFidelityProbe(response);
  if (verdict.faithful) return;

  throw new Error(
    `[eval] ABORTING sweep — the odoo-mock is STALE/unfaithful: ${verdict.reason}. ` +
      `A stale mock silently credits invalid account.move.line writes and CONTAMINATES the ` +
      `scorecard (pinchy#1165: the 2026-07-13 line-items baseline shipped this way). Rebuild ` +
      `the mock from source before sweeping: ` +
      `\`docker compose -p pinchy-eval -f docker-compose.yml -f docker-compose.e2e.yml ` +
      `-f docker-compose.eval.yml up -d --build odoo-mock\`, then re-run.`
  );
}
