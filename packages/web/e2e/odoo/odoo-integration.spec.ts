import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  login,
  createOdooConnection,
  setAgentPermissions,
  pinchyGet,
  pinchyDelete,
} from "./helpers";

test.describe("Odoo Integration", () => {
  let cookie: string;
  let connectionId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();
  });

  test("create Odoo connection", async () => {
    const res = await createOdooConnection(cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("odoo");
    connectionId = body.id;
  });

  test("list connections", async () => {
    const res = await pinchyGet("/api/integrations", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
  });

  test("set agent permissions", async () => {
    const agents = await pinchyGet("/api/agents", cookie);
    const agentId = (await agents.json())[0].id;
    const res = await setAgentPermissions(cookie, agentId, connectionId, [
      { model: "sale.order", operation: "read" },
      { model: "res.partner", operation: "read" },
    ]);
    expect(res.status).toBe(200);
  });

  test("delete connection", async () => {
    const res = await pinchyDelete(`/api/integrations/${connectionId}/with-permissions`, cookie);
    expect(res.status).toBe(200);
  });
});
