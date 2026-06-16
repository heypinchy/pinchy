import { describe, it, expect } from "vitest";

import { buildGatewayBlock } from "@/lib/openclaw-config/gateway";
import { OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS } from "@/lib/openclaw-config/paths";

describe("buildGatewayBlock", () => {
  it("always sets local/lan mode and token auth", () => {
    const gateway = buildGatewayBlock({}, "tok-123");
    expect(gateway.mode).toBe("local");
    expect(gateway.bind).toBe("lan");
    expect(gateway.auth).toEqual({ mode: "token", token: "tok-123" });
  });

  it("writes an empty token string when no token is available", () => {
    expect(buildGatewayBlock({}, null).auth).toEqual({ mode: "token", token: "" });
    expect(buildGatewayBlock({}, undefined).auth).toEqual({ mode: "token", token: "" });
    expect(buildGatewayBlock({}, "").auth).toEqual({ mode: "token", token: "" });
  });

  it("disables the built-in Control UI", () => {
    const controlUi = buildGatewayBlock({}, "tok").controlUi as Record<string, unknown>;
    expect(controlUi.enabled).toBe(false);
  });

  it("seeds the canonical allowedOrigins when the existing config has none", () => {
    const controlUi = buildGatewayBlock({}, "tok").controlUi as Record<string, unknown>;
    expect(controlUi.allowedOrigins).toEqual(OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS);
  });

  it("preserves an OpenClaw-enriched allowedOrigins array verbatim", () => {
    const enriched = ["https://example.test", "https://other.test"];
    const controlUi = buildGatewayBlock({ controlUi: { allowedOrigins: enriched } }, "tok")
      .controlUi as Record<string, unknown>;
    expect(controlUi.allowedOrigins).toBe(enriched);
  });

  it("re-seeds allowedOrigins when the existing value is not an array", () => {
    const controlUi = buildGatewayBlock({ controlUi: { allowedOrigins: "nope" } }, "tok")
      .controlUi as Record<string, unknown>;
    expect(controlUi.allowedOrigins).toEqual(OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS);
  });

  it("preserves OpenClaw-enriched sibling fields on the gateway block", () => {
    const gateway = buildGatewayBlock({ heartbeatMs: 5000, mode: "stale" }, "tok");
    // Enriched sibling survives, but Pinchy-managed fields win.
    expect(gateway.heartbeatMs).toBe(5000);
    expect(gateway.mode).toBe("local");
  });

  it("preserves enriched controlUi siblings while forcing enabled:false", () => {
    const controlUi = buildGatewayBlock({ controlUi: { theme: "dark", enabled: true } }, "tok")
      .controlUi as Record<string, unknown>;
    expect(controlUi.theme).toBe("dark");
    expect(controlUi.enabled).toBe(false);
  });
});
