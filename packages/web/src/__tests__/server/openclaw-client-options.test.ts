import { describe, it, expect, afterEach } from "vitest";

import { openClawClientOptions } from "@/server/openclaw-client-options";
import { startFakeGateway, type FakeGateway } from "@/test-helpers/fake-openclaw-gateway";

describe("openClawClientOptions", () => {
  let gateway: FakeGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  // OpenClaw 2026.9 hands a plugin approval only to a client that announced
  // it can take one. Without the capability every gated tool call ended
  // "Plugin approval unavailable (no approval route)" before Pinchy saw it.
  // Driven through the real openclaw-node client: the option is useless
  // unless the client puts it on the wire.
  it("announces the plugin-approvals capability in the connect handshake", async () => {
    gateway = await startFakeGateway();
    const {
      url: _url,
      deviceIdentityPath: _path,
      ...options
    } = openClawClientOptions({
      url: gateway.url,
      token: "t",
      deviceIdentityPath: "/unused",
    });

    await gateway.connectClient(options);

    expect(gateway.handshakes).toHaveLength(1);
    expect(gateway.handshakes[0].caps).toEqual(["plugin-approvals"]);
    expect(gateway.handshakes[0].scopes).toEqual(["operator.admin"]);
  });
});
