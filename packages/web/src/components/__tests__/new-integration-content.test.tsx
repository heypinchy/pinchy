/**
 * Tests for NewIntegrationContent — the page-level wrapper that renders the
 * picker grid and opens the dialog with the selected type pre-filled.
 *
 * The AddIntegrationDialog component is mocked here so these tests focus on
 * the picker page's wiring (fetch, navigation, dialog open/close) rather
 * than the dialog internals — those are covered by add-integration-dialog.test.tsx.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const routerPush = vi.fn();
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

// Stub the dialog so we can inspect the props NewIntegrationContent passes
// to it and trigger its onSuccess / onOpenChange callbacks directly.
const dialogRenders: Array<Record<string, unknown>> = [];
vi.mock("@/components/add-integration-dialog", () => ({
  AddIntegrationDialog: (props: Record<string, unknown>) => {
    dialogRenders.push(props);
    return (
      <div data-testid="add-integration-dialog">
        <span data-testid="initial-type">{String(props.initialType)}</span>
        <button
          type="button"
          onClick={() => (props.onSuccess as () => void)()}
          data-testid="dialog-success"
        >
          Success
        </button>
        <button
          type="button"
          onClick={() => (props.onOpenChange as (open: boolean) => void)(false)}
          data-testid="dialog-close"
        >
          Close
        </button>
      </div>
    );
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  dialogRenders.length = 0;
  vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  } as unknown as Response);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Import after mocks are set up.
async function importComponent() {
  const mod = await import("@/components/new-integration-content");
  return mod.NewIntegrationContent;
}

describe("NewIntegrationContent — initial render", () => {
  it("does not show the dialog until a tile is selected", async () => {
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    expect(screen.queryByTestId("add-integration-dialog")).not.toBeInTheDocument();
  });

  it("fetches existing integrations on mount", async () => {
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/integrations");
    });
  });

  it("renders a back link to the settings integrations tab", async () => {
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    const backLink = screen.getByLabelText(/Back to settings/i);
    expect(backLink).toHaveAttribute("href", "/settings?tab=integrations");
  });
});

describe("NewIntegrationContent — tile selection opens the dialog", () => {
  it("opens the dialog with initialType=mcp-github when GitHub tile is clicked", async () => {
    const user = userEvent.setup();
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await user.click(screen.getByRole("button", { name: /^GitHub/i }));

    expect(screen.getByTestId("add-integration-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("initial-type")).toHaveTextContent("mcp-github");
  });

  it("opens the dialog with initialType=odoo when Odoo tile is clicked", async () => {
    const user = userEvent.setup();
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await user.click(screen.getByRole("button", { name: /Odoo/i }));

    expect(screen.getByTestId("initial-type")).toHaveTextContent("odoo");
  });
});

describe("NewIntegrationContent — dialog callbacks", () => {
  it("hides the dialog and clears selection when the dialog requests close", async () => {
    const user = userEvent.setup();
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await user.click(screen.getByRole("button", { name: /^Notion/i }));
    expect(screen.getByTestId("add-integration-dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("dialog-close"));

    expect(screen.queryByTestId("add-integration-dialog")).not.toBeInTheDocument();
  });

  it("navigates back to /settings?tab=integrations on dialog success", async () => {
    const user = userEvent.setup();
    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await user.click(screen.getByRole("button", { name: /^Linear/i }));
    await user.click(screen.getByTestId("dialog-success"));

    expect(routerPush).toHaveBeenCalledWith("/settings?tab=integrations");
    expect(routerRefresh).toHaveBeenCalled();
  });
});

describe("NewIntegrationContent — singleton hints", () => {
  it("passes the configured singletons to the picker (disabling Web Search)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: "c1", type: "web-search" }],
    } as unknown as Response);

    const NewIntegrationContent = await importComponent();
    render(<NewIntegrationContent />);

    await waitFor(() => {
      const webSearch = screen.getByRole("button", { name: /Web Search/i });
      expect(webSearch).toHaveAttribute("aria-disabled", "true");
    });
  });
});
