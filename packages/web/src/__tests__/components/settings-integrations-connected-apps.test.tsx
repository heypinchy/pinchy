import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsIntegrations } from "@/components/settings-integrations";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: () => [],
}));

type OAuthState = {
  configured: boolean;
  clientId: string;
  connectionCount: number;
  tenantId?: string;
};

const NOT_CONFIGURED: OAuthState = { configured: false, clientId: "", connectionCount: 0 };

/**
 * Route the two fetch surfaces this component uses:
 *   - GET /api/integrations             -> connection list
 *   - GET /api/settings/oauth?provider  -> per-provider OAuth app state
 * so the Connected apps section and the connection list can be asserted
 * independently. DELETE/POST return a success shape.
 */
function mockFetch(opts: {
  connections?: unknown[];
  oauth?: Partial<Record<"google" | "microsoft", OAuthState>>;
  onDelete?: (url: string) => void;
}) {
  const connections = opts.connections ?? [];
  const oauth = opts.oauth ?? {};
  return vi.spyOn(global, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.startsWith("/api/settings/oauth")) {
      if (method === "DELETE") {
        opts.onDelete?.(url);
        return Promise.resolve({ ok: true, text: async () => "" } as unknown as Response);
      }
      const state =
        (url.includes("provider=microsoft") ? oauth.microsoft : oauth.google) ?? NOT_CONFIGURED;
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(state),
        json: async () => state,
      } as unknown as Response);
    }

    // /api/integrations
    return Promise.resolve({
      ok: true,
      text: async () => JSON.stringify(connections),
      json: async () => connections,
    } as unknown as Response);
  });
}

describe("SettingsIntegrations — Connected apps section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a Google card and a Microsoft card", async () => {
    const spy = mockFetch({});

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Connected apps")).toBeInTheDocument();
    });

    const section = screen.getByText("Connected apps").closest("[data-slot='card']")!;
    expect(within(section as HTMLElement).getByText("Google")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("Microsoft")).toBeInTheDocument();

    spy.mockRestore();
  });

  it("shows 'Not set up' + a Set up button for an unconfigured provider", async () => {
    const spy = mockFetch({ oauth: { google: NOT_CONFIGURED } });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    expect(within(googleRow).getByText(/Not set up/i)).toBeInTheDocument();
    expect(within(googleRow).getByRole("button", { name: /Set up/i })).toBeInTheDocument();
    expect(within(googleRow).queryByRole("button", { name: /^Reset$/i })).not.toBeInTheDocument();

    spy.mockRestore();
  });

  it("shows masked clientId, Configured status, Edit + Reset for a configured provider", async () => {
    const spy = mockFetch({
      oauth: {
        google: {
          configured: true,
          clientId: "1234567890-abcdefg.apps.googleusercontent.com",
          connectionCount: 2,
        },
      },
    });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    expect(within(googleRow).getByText(/Configured/i)).toBeInTheDocument();
    expect(within(googleRow).getByRole("button", { name: /Edit/i })).toBeInTheDocument();
    expect(within(googleRow).getByRole("button", { name: /^Reset$/i })).toBeInTheDocument();

    // Masked: first 6 chars followed by an ellipsis, and the full id is NOT shown.
    expect(within(googleRow).getByText(/123456…/)).toBeInTheDocument();
    expect(
      within(googleRow).queryByText("1234567890-abcdefg.apps.googleusercontent.com")
    ).not.toBeInTheDocument();

    spy.mockRestore();
  });

  it("shows the connected-mailbox count when > 0", async () => {
    const spy = mockFetch({
      oauth: {
        microsoft: { configured: true, clientId: "abcdef-ms-client", connectionCount: 3 },
      },
    });

    render(<SettingsIntegrations />);

    const msRow = await findProviderRow("Microsoft");
    expect(within(msRow).getByText(/3 mailbox(es)? connected/i)).toBeInTheDocument();

    spy.mockRestore();
  });

  it("clicking Set up opens the EditOAuthDialog for that provider", async () => {
    const user = userEvent.setup();
    const spy = mockFetch({ oauth: { microsoft: NOT_CONFIGURED } });

    render(<SettingsIntegrations />);

    const msRow = await findProviderRow("Microsoft");
    await user.click(within(msRow).getByRole("button", { name: /Set up/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Update your Microsoft OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });

    spy.mockRestore();
  });

  it("clicking Edit opens the EditOAuthDialog for that provider", async () => {
    const user = userEvent.setup();
    const spy = mockFetch({
      oauth: { google: { configured: true, clientId: "goog-client-id", connectionCount: 0 } },
    });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    await user.click(within(googleRow).getByRole("button", { name: /Edit/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Update your Google OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });

    spy.mockRestore();
  });

  it("Reset opens a confirm dialog naming the connection count, and confirming calls DELETE", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const spy = mockFetch({
      oauth: {
        google: { configured: true, clientId: "goog-client-id", connectionCount: 4 },
      },
      onDelete,
    });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    await user.click(within(googleRow).getByRole("button", { name: /^Reset$/i }));

    // Blast-radius warning names the count.
    await waitFor(() => {
      expect(screen.getByText(/disconnect 4 connected mailbox/i)).toBeInTheDocument();
    });

    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^Reset$/i }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("/api/settings/oauth?provider=google");
    });

    spy.mockRestore();
  });

  it("refetches the connection count when the Reset confirm dialog opens", async () => {
    const user = userEvent.setup();

    // The mount fetch reports 2 connected mailboxes. Between mount and the Reset
    // click a mailbox is added server-side, so a fresh GET reports 3. Opening the
    // confirm must show the fresh count (3), not the stale mount count (2).
    let googleGetCount = 0;
    const spy = vi.spyOn(global, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.startsWith("/api/settings/oauth")) {
        if (url.includes("provider=google") && method === "GET") {
          googleGetCount += 1;
          const connectionCount = googleGetCount === 1 ? 2 : 3;
          const state = { configured: true, clientId: "goog-client-id", connectionCount };
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(state),
            json: async () => state,
          } as unknown as Response);
        }
        const state = NOT_CONFIGURED;
        return Promise.resolve({
          ok: true,
          text: async () => JSON.stringify(state),
          json: async () => state,
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: async () => "[]",
        json: async () => [],
      } as unknown as Response);
    });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    // Mount count is 2.
    await waitFor(() => {
      expect(within(googleRow).getByText(/2 mailbox(es)? connected/i)).toBeInTheDocument();
    });
    const getsBeforeReset = googleGetCount;

    await user.click(within(googleRow).getByRole("button", { name: /^Reset$/i }));

    // Opening the confirm triggers a fresh GET and the warning names the fresh
    // count (3), not the stale mount count (2).
    await waitFor(() => {
      expect(screen.getByText(/disconnect 3 connected mailbox/i)).toBeInTheDocument();
    });
    expect(googleGetCount).toBeGreaterThan(getsBeforeReset);
    expect(screen.queryByText(/disconnect 2 connected mailbox/i)).not.toBeInTheDocument();

    spy.mockRestore();
  });

  it("falls back to the mount count if the refetch fails when opening Reset", async () => {
    const user = userEvent.setup();

    // Mount GET succeeds with 2; the refetch on open fails. The dialog must still
    // open and show the last-known count (2) rather than crashing.
    let googleGetCount = 0;
    const spy = vi.spyOn(global, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.startsWith("/api/settings/oauth")) {
        if (url.includes("provider=google") && method === "GET") {
          googleGetCount += 1;
          if (googleGetCount > 1) {
            return Promise.reject(new Error("network down"));
          }
          const state = { configured: true, clientId: "goog-client-id", connectionCount: 2 };
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(state),
            json: async () => state,
          } as unknown as Response);
        }
        const state = NOT_CONFIGURED;
        return Promise.resolve({
          ok: true,
          text: async () => JSON.stringify(state),
          json: async () => state,
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: async () => "[]",
        json: async () => [],
      } as unknown as Response);
    });

    render(<SettingsIntegrations />);

    const googleRow = await findProviderRow("Google");
    await waitFor(() => {
      expect(within(googleRow).getByText(/2 mailbox(es)? connected/i)).toBeInTheDocument();
    });

    await user.click(within(googleRow).getByRole("button", { name: /^Reset$/i }));

    await waitFor(() => {
      expect(screen.getByText(/disconnect 2 connected mailbox/i)).toBeInTheDocument();
    });

    spy.mockRestore();
  });

  it("mentions that changing only the Client Secret does not disconnect mailboxes", async () => {
    const spy = mockFetch({
      oauth: { google: { configured: true, clientId: "goog-client-id", connectionCount: 1 } },
    });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Connected apps")).toBeInTheDocument();
    });

    // The rotation hint distinguishes secret rotation (no reconnect) from
    // Client ID changes (reconnect required).
    expect(screen.getByText(/changing the client id requires reconnecting/i)).toBeInTheDocument();

    spy.mockRestore();
  });
});

/** Find the row/card for a provider by its label, scoped to the Connected apps card. */
async function findProviderRow(label: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByText("Connected apps")).toBeInTheDocument();
  });
  const section = screen.getByText("Connected apps").closest("[data-slot='card']") as HTMLElement;
  await waitFor(() => {
    expect(within(section).getByText(label)).toBeInTheDocument();
  });
  const labelEl = within(section).getByText(label);
  return labelEl.closest("[data-provider-row]") as HTMLElement;
}
