// packages/web/eval/eval-shared.ts
//
// Setup logic shared by both Eval-v1 (pinchy#669) spec files
// (eval-selftest.spec.ts, eval-models.spec.ts): creating and permissioning
// the Hetzner-scenario agent. Split out so each mode's spec stays a plain,
// unconditional Playwright test file — no runtime `test.skip(condition)`
// gating, which the repo's no-untracked-skips drift guard does not
// recognize as a conditional gate (only `.skipIf(` is exempt). Mode
// selection instead happens at the Playwright-config level via `testMatch`
// (see playwright.eval.config.ts).
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
import { resetOdooMock, seedOdooBaseline } from "./run-eval";

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

/**
 * Full scenario setup shared by both modes: reset + seed the Graph and Odoo
 * mocks, create Microsoft + Odoo connections, create an agent, grant email +
 * Odoo permissions, and allow the scenario's tools. Returns the agentId. The
 * agent's model is NOT pinned here — callers pin it per candidate model.
 */
export async function setupHetznerAgent(cookie: string): Promise<{
  agentId: string;
  emailConnectionId: string;
  odooConnectionId: string;
}> {
  await resetGraphMock();
  await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
  await resetOdooMock();
  await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);

  const emailConn = await createMicrosoftConnectionInDb("Eval-v1 Hetzner Microsoft");
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
  const odooConn = await createOdooConnection(cookie, "Eval-v1 Hetzner Odoo");
  if (odooConn.status !== 201) {
    throw new Error(`Odoo connection creation failed: ${String(odooConn.status)}`);
  }
  const odooConnBody = (await odooConn.json()) as { id: string };

  const createRes = await odooPinchyPost(
    "/api/agents",
    { name: "Eval-v1 Hetzner Invoice", templateId: "custom" },
    cookie
  );
  if (createRes.status !== 201) {
    throw new Error(`Agent creation failed: ${String(createRes.status)}`);
  }
  const agentId = ((await createRes.json()) as { id: string }).id;

  // Email read permission via the same PUT-integrations shape email specs use.
  const pinchyUrl = process.env.PINCHY_URL || "http://localhost:7777";
  const emailGrant = await fetch(`${pinchyUrl}/api/agents/${agentId}/integrations`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: pinchyUrl,
    },
    body: JSON.stringify({
      connectionId: emailConn.id,
      permissions: [{ model: "email", operation: "read" }],
    }),
  });
  if (!emailGrant.ok) {
    throw new Error(`Email permission grant failed: ${String(emailGrant.status)}`);
  }

  const odooGrant = await setAgentPermissions(cookie, agentId, odooConnBody.id, [
    { model: "account.move", operation: "create" },
    { model: "account.move", operation: "read" },
    { model: "res.partner", operation: "read" },
  ]);
  if (odooGrant.status !== 200) {
    throw new Error(`Odoo permission grant failed: ${String(odooGrant.status)}`);
  }

  const patchRes = await odooPinchyPatch(
    `/api/agents/${agentId}`,
    { allowedTools: HETZNER_ALLOWED_TOOLS },
    cookie
  );
  if (patchRes.status !== 200) {
    throw new Error(`Agent tool allowlist patch failed: ${String(patchRes.status)}`);
  }

  return { agentId, emailConnectionId: emailConn.id, odooConnectionId: odooConnBody.id };
}
