import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsIntegrations } from "@/components/settings-integrations";
import type { IntegrationConnection } from "@/lib/integrations/types";

// Mock use-integration-actions hook
vi.mock("@/hooks/use-integration-actions", () => ({
  useIntegrationActions: () => ({
    testing: null,
    syncing: null,
    testConnection: vi.fn(),
    syncSchema: vi.fn(),
    renameConnection: vi.fn(),
    deleteConnection: vi.fn(),
  }),
}));

// Mock sonner (used transitively)
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "conn-1",
    type: "odoo",
    name: "My Odoo",
    description: "",
    credentials: {},
    data: {
      models: [{ model: "res.partner" }],
      lastSyncAt: "2026-04-13T12:00:00.000Z",
    },
    createdAt: "2026-04-13T12:00:00.000Z",
    updatedAt: "2026-04-13T12:00:00.000Z",
    ...overrides,
  };
}

function mockFetchConnections(connections: IntegrationConnection[]) {
  return vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => connections,
  } as Response);
}

describe("SettingsIntegrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders OdooIcon for Odoo connections", async () => {
    const conn = makeConnection({ type: "odoo", name: "My Odoo ERP" });
    const fetchSpy = mockFetchConnections([conn]);

    const { container } = render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("My Odoo ERP")).toBeInTheDocument();
    });

    // OdooIcon uses an SVG with the odoo-holes mask
    const odooSvg = container.querySelector("mask#odoo-holes");
    expect(odooSvg).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders PipedriveIcon for Pipedrive connections", async () => {
    const conn = makeConnection({
      type: "pipedrive",
      name: "My Pipedrive CRM",
      data: {
        entities: [{ entity: "deals" }],
        lastSyncAt: "2026-04-13T12:00:00.000Z",
      },
    });
    const fetchSpy = mockFetchConnections([conn]);

    const { container } = render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("My Pipedrive CRM")).toBeInTheDocument();
    });

    // PipedriveIcon uses an SVG with viewBox 0 0 32 32
    const svgs = container.querySelectorAll("svg");
    const pipedriveSvg = Array.from(svgs).find(
      (svg) => svg.getAttribute("viewBox") === "0 0 32 32"
    );
    expect(pipedriveSvg).toBeInTheDocument();

    // Should NOT have the Odoo mask
    const odooMask = container.querySelector("mask#odoo-holes");
    expect(odooMask).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders Plug icon for unknown connection types", async () => {
    const conn = makeConnection({
      type: "unknown-crm",
      name: "Mystery CRM",
      data: { lastSyncAt: "2026-04-13T12:00:00.000Z" },
    });
    const fetchSpy = mockFetchConnections([conn]);

    const { container } = render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Mystery CRM")).toBeInTheDocument();
    });

    // Should NOT have Odoo SVG
    const odooMask = container.querySelector("mask#odoo-holes");
    expect(odooMask).not.toBeInTheDocument();

    // Should NOT have Pipedrive SVG (viewBox 0 0 32 32)
    const svgs = container.querySelectorAll("svg");
    const pipedriveSvg = Array.from(svgs).find(
      (svg) => svg.getAttribute("viewBox") === "0 0 32 32"
    );
    expect(pipedriveSvg).toBeUndefined();

    // The Plug icon from lucide-react should be present in the connection row
    // (lucide icons render as SVG with a specific class)
    const connectionRow = screen.getByText("Mystery CRM").closest(".rounded-lg");
    const connectionSvg = connectionRow?.querySelector("svg");
    expect(connectionSvg).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("uses Odoo category labels for Odoo connections", async () => {
    const conn = makeConnection({
      type: "odoo",
      name: "Odoo Production",
      data: {
        models: [{ model: "res.partner" }, { model: "sale.order" }],
        lastSyncAt: "2026-04-13T12:00:00.000Z",
      },
    });
    const fetchSpy = mockFetchConnections([conn]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Odoo Production")).toBeInTheDocument();
    });

    // Odoo labels: "Contacts" (from res.partner) and "Sales" (from sale.order)
    expect(screen.getByText("2 data categories")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("uses Pipedrive category labels for Pipedrive connections", async () => {
    const conn = makeConnection({
      type: "pipedrive",
      name: "Pipedrive Sales",
      data: {
        entities: [{ entity: "deals" }, { entity: "persons" }, { entity: "products" }],
        lastSyncAt: "2026-04-13T12:00:00.000Z",
      },
    });
    const fetchSpy = mockFetchConnections([conn]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Pipedrive Sales")).toBeInTheDocument();
    });

    // Pipedrive labels: "CRM" (deals+persons) and "Products" (products)
    expect(screen.getByText("2 data categories")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows 0 categories for Pipedrive when using Odoo data shape (models instead of entities)", async () => {
    // If a Pipedrive connection mistakenly had Odoo-shaped data, it should
    // correctly use the Pipedrive label function which expects `entities`, not `models`
    const conn = makeConnection({
      type: "pipedrive",
      name: "Pipedrive Mismatched",
      data: {
        models: [{ model: "res.partner" }], // Odoo-shaped data — wrong for Pipedrive
        lastSyncAt: "2026-04-13T12:00:00.000Z",
      },
    });
    const fetchSpy = mockFetchConnections([conn]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Pipedrive Mismatched")).toBeInTheDocument();
    });

    // Pipedrive's getAccessibleCategoryLabels looks for `entities`, not `models`
    // So it should return 0 categories
    expect(screen.getByText("0 data categories")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});
