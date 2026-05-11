import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn(),
}));
vi.mock("@/lib/integrations/brave-probe", () => ({
  probeBraveApiKey: vi.fn(),
}));

import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeIntegrationCredentials", () => {
  const validOdooCreds = {
    url: "https://odoo.example.com",
    db: "mydb",
    login: "admin",
    apiKey: "sk-xxx",
    uid: 1,
  };

  it("odoo: returns success when fetchOdooSchema succeeds", async () => {
    vi.mocked(fetchOdooSchema).mockResolvedValue({
      success: true,
      models: 5,
      data: {} as never,
      lastSyncAt: new Date().toISOString(),
    } as never);
    const res = await probeIntegrationCredentials("odoo", validOdooCreds);
    expect(res).toEqual({ success: true });
  });

  it("odoo: returns failure with reason from fetchOdooSchema", async () => {
    vi.mocked(fetchOdooSchema).mockResolvedValue({
      success: false,
      error: "Access denied",
    } as never);
    const res = await probeIntegrationCredentials("odoo", validOdooCreds);
    expect(res).toEqual({ success: false, reason: "Access denied" });
  });

  it("odoo: returns failure for invalid credentials shape", async () => {
    const res = await probeIntegrationCredentials("odoo", {
      url: "https://o",
      db: "p",
      login: "u",
    });
    expect(res).toEqual({ success: false, reason: "Invalid credentials format" });
    expect(fetchOdooSchema).not.toHaveBeenCalled();
  });

  it("web-search: delegates to probeBraveApiKey", async () => {
    vi.mocked(probeBraveApiKey).mockResolvedValue({ success: true });
    const res = await probeIntegrationCredentials("web-search", { apiKey: "k" });
    expect(res).toEqual({ success: true });
    expect(probeBraveApiKey).toHaveBeenCalledWith("k");
  });

  it("web-search: returns failure when apiKey is missing", async () => {
    const res = await probeIntegrationCredentials("web-search", {});
    expect(res).toEqual({ success: false, reason: "apiKey is required" });
    expect(probeBraveApiKey).not.toHaveBeenCalled();
  });

  it("returns failure with explicit message for unknown type", async () => {
    const res = await probeIntegrationCredentials("unknown-type" as never, {});
    expect(res).toEqual({
      success: false,
      reason: "Cannot probe credentials for unknown type: unknown-type",
    });
  });
});
