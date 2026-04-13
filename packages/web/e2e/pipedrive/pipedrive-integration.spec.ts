import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForPipedriveMock,
  resetPipedriveMock,
  login,
  createPipedriveConnection,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyDelete,
} from "./helpers";

test.describe("Pipedrive Integration", () => {
  let cookie: string;
  let connectionId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForPipedriveMock();
    await resetPipedriveMock();
    cookie = await login();
  });

  test("create Pipedrive connection", async () => {
    const res = await createPipedriveConnection(cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("pipedrive");
    expect(body.name).toBe("Test Pipedrive");
    connectionId = body.id;
  });

  test("list connections includes Pipedrive", async () => {
    const res = await pinchyGet("/api/integrations", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    const pd = body.find((c: any) => c.type === "pipedrive");
    expect(pd).toBeDefined();
    expect(pd.id).toBe(connectionId);
  });

  test("get single connection", async () => {
    const res = await pinchyGet(`/api/integrations/${connectionId}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("pipedrive");
    // Credentials should be masked (no apiToken)
    expect(body.credentials.companyDomain).toBe("test-company");
    expect(body.credentials.apiToken).toBeUndefined();
  });

  test("test credentials", async () => {
    const res = await pinchyPost(
      "/api/integrations/test-credentials",
      {
        type: "pipedrive",
        credentials: { apiToken: "test-pipedrive-token" },
      },
      cookie
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.companyDomain).toBe("test-company");
    expect(body.companyName).toBe("Test Company");
  });

  test("sync schema", async () => {
    const res = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.entities).toBeGreaterThan(0);
  });

  test("rename connection", async () => {
    const res = await pinchyPatch(
      `/api/integrations/${connectionId}`,
      {
        name: "Renamed Pipedrive",
      },
      cookie
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed Pipedrive");
  });

  test("delete connection", async () => {
    const res = await pinchyDelete(`/api/integrations/${connectionId}`, cookie);
    expect(res.status).toBe(200);

    // Verify it's gone
    const listRes = await pinchyGet("/api/integrations", cookie);
    const connections = await listRes.json();
    const found = connections.find((c: any) => c.id === connectionId);
    expect(found).toBeUndefined();
  });
});
