// packages/web/eval/eval-shared.ts
//
// Setup logic shared by the Eval spec files (eval-selftest.spec.ts,
// eval-models.spec.ts): creating and permissioning the per-domain eval
// agents. Split out so each mode's spec stays a plain, unconditional
// Playwright test file — no runtime `test.skip(condition)` gating, which the
// repo's no-untracked-skips drift guard does not recognize as a conditional
// gate (only `.skipIf(` is exempt). Mode selection instead happens at the
// Playwright-config level via `testMatch` (see playwright.eval.config.ts).
import {
  createOdooConnection,
  setAgentPermissions,
  pinchyPost as odooPinchyPost,
  pinchyPatch as odooPinchyPatch,
} from "../e2e/odoo/helpers";
import {
  createMicrosoftConnectionInDb,
  resetGraphMock,
  seedGraphMockMessages,
} from "../e2e/email/helpers";
import { hetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { crmLeadScenario } from "./scenarios/crm-lead";
import { resetOdooMock, seedOdooBaseline, PINCHY_URL } from "./run-eval";

export const HETZNER_ALLOWED_TOOLS = [
  "email_list",
  "email_search",
  "email_read",
  "email_get_attachment",
  "odoo_create",
  // Read + count let the agent VERIFY state before/after writing — needed for
  // the duplicate-guard scenario (check whether the bill already exists) and,
  // more broadly, so "did the model check the record back?" is a real choice
  // the model can make rather than a capability it lacks. account.move read is
  // already granted in the permission block below; odoo_count is a read op.
  "odoo_read",
  "odoo_count",
];

// No email_get_attachment: the crm-lead domain has no attachment leg — the
// inquiry facts live in the email's free prose (see scenarios/crm-lead.ts).
export const CRM_ALLOWED_TOOLS = [
  "email_list",
  "email_search",
  "email_read",
  "odoo_create",
  "odoo_read",
  "odoo_count",
];

interface EvalAgentSetup {
  agentId: string;
  emailConnectionId: string;
  odooConnectionId: string;
}

interface EvalAgentConfig {
  emailConnectionName: string;
  odooConnectionName: string;
  agentName: string;
  graphSeedMessage: Parameters<typeof seedGraphMockMessages>[0][number];
  odooBaseline: Parameters<typeof seedOdooBaseline>[0];
  odooPermissions: Array<{ model: string; operation: string }>;
  allowedTools: string[];
}

/**
 * Domain-agnostic scenario setup shared by both eval domains: reset + seed the
 * Graph and Odoo mocks, create Microsoft + Odoo connections, create an agent,
 * grant email + Odoo permissions, and allow the domain's tools. Returns the
 * agentId. The agent's model is NOT pinned here — callers pin it per candidate
 * model. Seeds the BASE scenario's fixtures; sibling variants (rejected /
 * silent-failure / duplicate) re-seed per run via resetGraphMock /
 * seedGraphMockMessages / resetOdooMock / seedOdooBaseline with their own
 * fixtures, exactly as the selftest/models specs already do for the Hetzner
 * family.
 */
async function setupEvalAgent(cookie: string, config: EvalAgentConfig): Promise<EvalAgentSetup> {
  await resetGraphMock();
  await seedGraphMockMessages([config.graphSeedMessage]);
  await resetOdooMock();
  await seedOdooBaseline(config.odooBaseline);

  const emailConn = await createMicrosoftConnectionInDb(config.emailConnectionName);
  // createMicrosoftConnectionInDb seeds ALREADY-EXPIRED credentials, so the
  // first email tool call triggers a token refresh. Without app-level OAuth
  // settings the refresh route 503s with OAuthSettingsMissingError, so seed
  // them here exactly as email-microsoft.spec.ts does (the graph mock accepts
  // any client id/secret).
  const oauthRes = await odooPinchyPost(
    "/api/settings/oauth",
    { provider: "microsoft", clientId: "eval-v1-client-id", clientSecret: "eval-v1-client-secret" },
    cookie
  );
  if (!oauthRes.ok) {
    throw new Error(`Microsoft OAuth settings seed failed: ${String(oauthRes.status)}`);
  }
  const odooConn = await createOdooConnection(cookie, config.odooConnectionName);
  if (odooConn.status !== 201) {
    throw new Error(`Odoo connection creation failed: ${String(odooConn.status)}`);
  }
  const odooConnBody = (await odooConn.json()) as { id: string };

  const createRes = await odooPinchyPost(
    "/api/agents",
    { name: config.agentName, templateId: "custom" },
    cookie
  );
  if (createRes.status !== 201) {
    throw new Error(`Agent creation failed: ${String(createRes.status)}`);
  }
  const agentId = ((await createRes.json()) as { id: string }).id;

  // Email read permission via the same PUT-integrations shape email specs use.
  const emailGrant = await fetch(`${PINCHY_URL}/api/agents/${agentId}/integrations`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: PINCHY_URL,
    },
    body: JSON.stringify({
      connectionId: emailConn.id,
      permissions: [{ model: "email", operation: "read" }],
    }),
  });
  if (!emailGrant.ok) {
    throw new Error(`Email permission grant failed: ${String(emailGrant.status)}`);
  }

  const odooGrant = await setAgentPermissions(
    cookie,
    agentId,
    odooConnBody.id,
    config.odooPermissions
  );
  if (odooGrant.status !== 200) {
    throw new Error(`Odoo permission grant failed: ${String(odooGrant.status)}`);
  }

  const patchRes = await odooPinchyPatch(
    `/api/agents/${agentId}`,
    { allowedTools: config.allowedTools },
    cookie
  );
  if (patchRes.status !== 200) {
    throw new Error(`Agent tool allowlist patch failed: ${String(patchRes.status)}`);
  }

  return { agentId, emailConnectionId: emailConn.id, odooConnectionId: odooConnBody.id };
}

/**
 * Full Hetzner-scenario setup shared by both modes (see `setupEvalAgent` for
 * the steps). Returns the agentId; the agent's model is NOT pinned here —
 * callers pin it per candidate model.
 */
export async function setupHetznerAgent(cookie: string): Promise<{
  agentId: string;
  emailConnectionId: string;
  odooConnectionId: string;
}> {
  return setupEvalAgent(cookie, {
    emailConnectionName: "Eval-v1 Hetzner Microsoft",
    odooConnectionName: "Eval-v1 Hetzner Odoo",
    agentName: "Eval-v1 Hetzner Invoice",
    graphSeedMessage: hetznerInvoiceScenario.graphSeedMessage,
    odooBaseline: hetznerInvoiceScenario.odooBaseline,
    odooPermissions: [
      { model: "account.move", operation: "create" },
      { model: "account.move", operation: "read" },
      // Line-items scenario (pinchy#669): creating a bill WITH invoice_line_ids
      // needs create access on the child line model, or the nested create is
      // permission-denied. Harmless for scenarios that create header-only bills.
      { model: "account.move.line", operation: "create" },
      { model: "res.partner", operation: "read" },
    ],
    allowedTools: HETZNER_ALLOWED_TOOLS,
  });
}

/**
 * CRM-domain counterpart of `setupHetznerAgent` (Eval-v2 Task 9, pinchy#803):
 * seeds the crm-lead base scenario's fixtures and permissions the agent for
 * the lead loop. Same public shape; sibling variants re-seed per run exactly
 * like the Hetzner family (see `setupEvalAgent`).
 */
export async function setupCrmAgent(cookie: string): Promise<{
  agentId: string;
  emailConnectionId: string;
  odooConnectionId: string;
}> {
  return setupEvalAgent(cookie, {
    emailConnectionName: "Eval-v2 CRM Microsoft",
    odooConnectionName: "Eval-v2 CRM Odoo",
    agentName: "Eval-v2 CRM Lead",
    graphSeedMessage: crmLeadScenario.graphSeedMessage,
    odooBaseline: crmLeadScenario.odooBaseline,
    odooPermissions: [
      // Create-grant on crm.lead ONLY — no res.partner/mail.activity create.
      // The duplicate grader (gradeDuplicateAvoidance, src/lib/eval/graders.ts)
      // detects "created a second lead" by tool NAME (`odoo_create`), so any
      // additional legitimate create grant would let a diligent model create
      // e.g. a partner or activity and falsely grade `duplicate-created`.
      { model: "crm.lead", operation: "create" },
      { model: "crm.lead", operation: "read" },
      { model: "res.partner", operation: "read" },
    ],
    allowedTools: CRM_ALLOWED_TOOLS,
  });
}
