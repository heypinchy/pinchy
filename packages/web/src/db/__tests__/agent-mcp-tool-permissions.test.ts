import { describe, expect, it } from "vitest";
import { agentMcpToolPermissions } from "../schema";

describe("agentMcpToolPermissions schema", () => {
  it("exposes expected columns", () => {
    expect(agentMcpToolPermissions.id).toBeDefined();
    expect(agentMcpToolPermissions.agentId).toBeDefined();
    expect(agentMcpToolPermissions.connectionId).toBeDefined();
    expect(agentMcpToolPermissions.toolName).toBeDefined();
  });
});
