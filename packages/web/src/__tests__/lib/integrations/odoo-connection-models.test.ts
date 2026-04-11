import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrderBy, mockWhere, mockSelect } = vi.hoisted(() => {
  const mockOrderBy = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return { mockOrderBy, mockWhere, mockSelect };
});

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: {
    type: "type",
    data: "data",
    createdAt: "created_at",
  },
}));

import { getConnectionModels } from "@/lib/integrations/odoo-connection-models";
import { integrationConnections } from "@/db/schema";

describe("getConnectionModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  });

  it("returns null when no Odoo connections exist", async () => {
    mockOrderBy.mockResolvedValue([]);
    const result = await getConnectionModels();
    expect(result).toBeNull();
  });

  it("returns models from the first connection (by createdAt) when multiple exist", async () => {
    mockOrderBy.mockResolvedValue([
      { data: { models: [{ model: "sale.order", name: "Sales Order" }] } },
      { data: { models: [{ model: "res.partner", name: "Contact" }] } },
    ]);

    const result = await getConnectionModels();

    expect(result).toEqual([{ model: "sale.order", name: "Sales Order" }]);
  });

  it("orders Odoo connections deterministically by createdAt", async () => {
    mockOrderBy.mockResolvedValue([{ data: { models: [] } }]);

    await getConnectionModels();

    // The query must call .orderBy(integrationConnections.createdAt) so that
    // picking connections[0] is deterministic when multiple connections exist.
    expect(mockOrderBy).toHaveBeenCalledTimes(1);
    expect(mockOrderBy).toHaveBeenCalledWith(integrationConnections.createdAt);
  });

  it("returns null when the connection has no cached models", async () => {
    mockOrderBy.mockResolvedValue([{ data: null }]);
    const result = await getConnectionModels();
    expect(result).toBeNull();
  });
});
