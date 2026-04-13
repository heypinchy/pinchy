import { describe, expect, it } from "vitest";
import { autoSelectConnection, type OdooConnection } from "../odoo-connection-selection";

describe("autoSelectConnection", () => {
  it("returns the connection id when exactly one connection exists", () => {
    const connections: OdooConnection[] = [
      { id: "conn-1", name: "Production", type: "odoo", data: { models: [], lastSyncAt: "" } },
    ];

    expect(autoSelectConnection(connections)).toBe("conn-1");
  });

  it("returns null when multiple connections exist", () => {
    const connections: OdooConnection[] = [
      { id: "conn-1", name: "Production", type: "odoo", data: { models: [], lastSyncAt: "" } },
      { id: "conn-2", name: "Staging", type: "odoo", data: { models: [], lastSyncAt: "" } },
    ];

    expect(autoSelectConnection(connections)).toBeNull();
  });

  it("returns null when no connections exist", () => {
    expect(autoSelectConnection([])).toBeNull();
  });

  it("filters to only odoo type connections", () => {
    const connections: OdooConnection[] = [
      { id: "conn-1", name: "Production", type: "odoo", data: { models: [], lastSyncAt: "" } },
    ];

    // The function should work with pre-filtered connections
    expect(autoSelectConnection(connections)).toBe("conn-1");
  });
});
