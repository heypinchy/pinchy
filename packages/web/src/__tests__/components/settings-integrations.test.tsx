import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

const activeOdooConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "Production ERP",
  description: "",
  credentials: "encrypted",
  status: "active",
  lastError: null,
  lastErrorAt: null,
  data: { lastSyncAt: "2026-04-13T12:00:00Z", categories: [] },
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const authFailedOdooConnection = {
  id: "conn-odoo-2",
  type: "odoo",
  name: "Staging ERP",
  description: "",
  credentials: "encrypted",
  status: "auth_failed",
  lastError: "401 from Odoo",
  lastErrorAt: "2026-05-10T10:00:00Z",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
  cannotDecrypt: false,
};

const authFailedMicrosoftConnection = {
  id: "conn-ms-2",
  type: "microsoft",
  name: "user@outlook.com",
  description: "",
  credentials: "encrypted",
  status: "auth_failed",
  lastError: "401 from Microsoft",
  lastErrorAt: "2026-05-10T10:00:00Z",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
  cannotDecrypt: false,
};

const authFailedGoogleConnection = {
  id: "conn-google-2",
  type: "google",
  name: "user@gmail.com",
  description: "",
  credentials: "encrypted",
  status: "auth_failed",
  lastError: "401 from Google",
  lastErrorAt: "2026-05-10T10:00:00Z",
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
  cannotDecrypt: false,
};

const activeMicrosoftConnection = {
  id: "conn-ms-active",
  type: "microsoft",
  name: "user@outlook.com",
  description: "",
  credentials: "encrypted",
  status: "active",
  lastError: null,
  lastErrorAt: null,
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const activeGoogleConnection = {
  id: "conn-google-active",
  type: "google",
  name: "user@gmail.com",
  description: "",
  credentials: "encrypted",
  status: "active",
  lastError: null,
  lastErrorAt: null,
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const activeImapConnection = {
  id: "conn-imap-1",
  type: "imap",
  name: "Work email (IMAP)",
  description: "",
  credentials: "encrypted",
  status: "active",
  lastError: null,
  lastErrorAt: null,
  data: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const pendingMicrosoftConnection = {
  id: "conn-ms-pending-appcheck",
  type: "microsoft",
  name: "Microsoft (connecting...)",
  description: "",
  credentials: "{}",
  status: "pending",
  lastError: null,
  lastErrorAt: null,
  data: null,
  createdAt: "2026-06-30T10:00:00Z",
  updatedAt: "2026-06-30T10:00:00Z",
  cannotDecrypt: false,
};

function mockFetchConnections(
  connections: unknown[],
  appConfigured: { google?: boolean; microsoft?: boolean } = {}
) {
  return vi.spyOn(global, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // The Connected apps section (and, as of this change, the connection-list
    // status badges) fetch per-provider OAuth app state on mount. Default both
    // providers to unconfigured; individual tests override via appConfigured.
    if (url.startsWith("/api/settings/oauth")) {
      const provider = new URL(url, "http://localhost").searchParams.get("provider");
      const configured =
        provider === "google"
          ? (appConfigured.google ?? false)
          : provider === "microsoft"
            ? (appConfigured.microsoft ?? false)
            : false;
      const state = { configured, clientId: "", connectionCount: 0 };
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(state),
        json: async () => state,
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      text: async () => JSON.stringify(connections),
      json: async () => connections,
    } as unknown as Response);
  });
}

describe("SettingsIntegrations — auth_failed state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a warning icon and 'Authentication failed' label when status is auth_failed", async () => {
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    expect(screen.getByText(/Authentication failed/i)).toBeInTheDocument();

    const warningIcon = document.querySelector("[aria-label='Authentication failed']");
    expect(warningIcon).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders lastError text when status is auth_failed", async () => {
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    expect(screen.getByText("401 from Odoo")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders green check + 'Connected' when status is active", async () => {
    const fetchSpy = mockFetchConnections([activeOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    // Exact match: the "Connected apps" section title also contains "Connected",
    // so the loose /Connected/i regex would match two nodes. The connection
    // status label is exactly "Connected".
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/Authentication failed/i)).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows a 'Reconnect' menu item in the dropdown for auth_failed cards", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([authFailedOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Staging ERP")).toBeInTheDocument();
    });

    const row = screen.getByText("Staging ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Reconnect")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows a 'Reconnect' menu item in the dropdown for auth_failed Microsoft cards", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([authFailedMicrosoftConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    const row = screen.getByText("user@outlook.com").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Reconnect")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders the red 'Authentication failed' state (not 'Connected') for auth_failed Gmail connections", async () => {
    const fetchSpy = mockFetchConnections([authFailedGoogleConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    });

    expect(screen.getByText(/Authentication failed/i)).toBeInTheDocument();
    const warningIcon = document.querySelector("[aria-label='Authentication failed']");
    expect(warningIcon).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not show 'Reconnect' for active connections", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeOdooConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    const row = screen.getByText("Production ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — IMAP connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the IMAP label and mail icon for an imap connection", async () => {
    const fetchSpy = mockFetchConnections([activeImapConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Work email (IMAP)")).toBeInTheDocument();
    });

    const row = screen.getByText("Work email (IMAP)").closest("[class*='rounded-lg']")!;
    expect(row.querySelector("svg.lucide-mail")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not show the OAuth 'Reconnect' action for an imap connection", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeImapConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Work email (IMAP)")).toBeInTheDocument();
    });

    const row = screen.getByText("Work email (IMAP)").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows Rename, Test Connection, and Delete actions for an imap connection (no Edit credentials dialog yet)", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeImapConnection]);

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Work email (IMAP)")).toBeInTheDocument();
    });

    const row = screen.getByText("Work email (IMAP)").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Test Connection")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    // Edit credentials would open a dead-end dialog (mask-credentials.ts and the
    // PATCH route don't know the imap shape yet) — deliberately not offered.
    expect(screen.queryByText("Edit credentials")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — pending OAuth connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'Setup in progress' for Microsoft pending connection", async () => {
    const fetchSpy = mockFetchConnections([
      {
        id: "ms-pending-1",
        type: "microsoft",
        name: "Microsoft (connecting...)",
        description: "",
        credentials: "{}",
        status: "pending",
        lastError: null,
        lastErrorAt: null,
        data: null,
        createdAt: "2026-06-30T10:00:00Z",
        updatedAt: "2026-06-30T10:00:00Z",
        cannotDecrypt: false,
      },
    ]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("shows 'Setup in progress' for Google pending connection (existing behavior preserved)", async () => {
    const fetchSpy = mockFetchConnections([
      {
        id: "goog-pending-1",
        type: "google",
        name: "Google (connecting...)",
        description: "",
        credentials: "{}",
        status: "pending",
        lastError: null,
        lastErrorAt: null,
        data: null,
        createdAt: "2026-06-30T10:00:00Z",
        updatedAt: "2026-06-30T10:00:00Z",
        cannotDecrypt: false,
      },
    ]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("shows 'Cancel setup' (not 'Delete') in the dropdown for a Microsoft pending connection", async () => {
    // A half-finished OAuth setup is aborted, not a working integration deleted —
    // the teardown action must read "Cancel setup" for any pending connection.
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([
      {
        id: "ms-pending-cancel",
        type: "microsoft",
        name: "Microsoft (connecting…)",
        description: "",
        credentials: "{}",
        status: "pending",
        lastError: null,
        lastErrorAt: null,
        data: null,
        createdAt: "2026-06-30T10:00:00Z",
        updatedAt: "2026-06-30T10:00:00Z",
        cannotDecrypt: false,
      },
    ]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Microsoft (connecting…)")).toBeInTheDocument();
    });

    const row = screen.getByText("Microsoft (connecting…)").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Cancel setup")).toBeInTheDocument();
    // Pending connections have no meaningful other actions — no destructive
    // "Delete" label, and no Rename/Test for a connection that isn't live yet.
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows 'Delete' (not 'Cancel setup') for an active connection", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeOdooConnection]);

    render(<SettingsIntegrations />);
    await waitFor(() => {
      expect(screen.getByText("Production ERP")).toBeInTheDocument();
    });

    const row = screen.getByText("Production ERP").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Cancel setup")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — live-update polling for pending connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Always hand real timers back to any test that runs after us, otherwise a
    // leaked fake-timer clock destabilises unrelated suites.
    vi.useRealTimers();
  });

  it("re-fetches while a connection is pending and updates the UI when it resolves", async () => {
    vi.useFakeTimers();

    const pendingConnection = {
      id: "ms-pending-poll",
      type: "microsoft",
      name: "user@outlook.com",
      description: "",
      credentials: "{}",
      status: "pending",
      lastError: null,
      lastErrorAt: null,
      data: null,
      createdAt: "2026-06-30T10:00:00Z",
      updatedAt: "2026-06-30T10:00:00Z",
      cannotDecrypt: false,
    };
    const activeConnection = { ...pendingConnection, status: "active" };

    // First connection-list fetch returns pending; every subsequent one returns
    // active — simulating the server-side transition after the OAuth flow finishes.
    let connectionsFetches = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("/api/settings/oauth")) {
        // This suite exercises polling/transition behavior, not the derived
        // app-configured state, so report the Microsoft app as configured —
        // otherwise the "active" assertions below would hit the (correct,
        // separately-tested) "App not configured" branch instead of "Connected".
        const state = { configured: true, clientId: "", connectionCount: 0 };
        return Promise.resolve({
          ok: true,
          text: async () => JSON.stringify(state),
          json: async () => state,
        } as unknown as Response);
      }
      // /api/integrations
      connectionsFetches += 1;
      const body = connectionsFetches === 1 ? [pendingConnection] : [activeConnection];
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response);
    });

    render(<SettingsIntegrations />);

    // Initial render shows the pending state.
    await vi.waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    // Advance past the poll interval — the component should re-fetch and pick up
    // the now-active connection without a manual reload.
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.waitFor(() => {
      expect(screen.queryByText("Setup in progress")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not keep polling once no connection is pending", async () => {
    vi.useFakeTimers();

    const activeConnection = {
      id: "ms-active-poll",
      type: "microsoft",
      name: "user@outlook.com",
      description: "",
      credentials: "{}",
      status: "active",
      lastError: null,
      lastErrorAt: null,
      data: null,
      createdAt: "2026-06-30T10:00:00Z",
      updatedAt: "2026-06-30T10:00:00Z",
      cannotDecrypt: false,
    };

    let connectionsFetches = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("/api/settings/oauth")) {
        // Same rationale as the test above: this suite is about poll cadence,
        // not the derived app-configured badge, so report the app as configured.
        const state = { configured: true, clientId: "", connectionCount: 0 };
        return Promise.resolve({
          ok: true,
          text: async () => JSON.stringify(state),
          json: async () => state,
        } as unknown as Response);
      }
      connectionsFetches += 1;
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify([activeConnection]),
        json: async () => [activeConnection],
      } as unknown as Response);
    });

    render(<SettingsIntegrations />);

    await vi.waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    const fetchesAfterMount = connectionsFetches;
    await vi.advanceTimersByTimeAsync(30_000);
    // No pending connection => no additional connection-list fetches beyond mount.
    expect(connectionsFetches).toBe(fetchesAfterMount);

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — derived 'app not configured' state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 'App not configured' (not 'Connected') for an active Microsoft connection when the Microsoft app was removed", async () => {
    const fetchSpy = mockFetchConnections([activeMicrosoftConnection], { microsoft: false });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    // The "App not configured" badge is derived from a SECOND async fetch
    // (GET /api/settings/oauth?provider=…) that resolves independently of the
    // connections list above, so wait for it to settle with findByText rather
    // than asserting synchronously right after the email renders — otherwise
    // the badge is still on its default "Connected" state and the assertion
    // races the app-config fetch (intermittent CI failure).
    expect(await screen.findByText("App not configured")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("still renders 'Connected' for an active Microsoft connection when the Microsoft app is configured (regression guard)", async () => {
    const fetchSpy = mockFetchConnections([activeMicrosoftConnection], { microsoft: true });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("App not configured")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("renders 'App not configured' (not 'Connected') for an active Google connection when the Google app was removed", async () => {
    const fetchSpy = mockFetchConnections([activeGoogleConnection], { google: false });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    });

    // See the Microsoft case above: the "App not configured" badge comes from a
    // second, independently-resolving app-config fetch, so wait for it with
    // findByText instead of asserting synchronously (avoids the CI race where
    // the badge is still showing its default "Connected" state).
    expect(await screen.findByText("App not configured")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("still renders 'Connected' for an active Google connection when the Google app is configured (regression guard)", async () => {
    const fetchSpy = mockFetchConnections([activeGoogleConnection], { google: true });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("App not configured")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("keeps the 'Reconnect' menu item available for an active connection flagged as app-not-configured", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchConnections([activeMicrosoftConnection], { microsoft: false });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("App not configured")).toBeInTheDocument();
    });

    const row = screen.getByText("user@outlook.com").closest("[class*='rounded-lg']")!;
    const buttons = row.querySelectorAll("button");
    const menuButton = buttons[buttons.length - 1];
    await user.click(menuButton);

    expect(screen.getByText("Reconnect")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("does not affect a 'pending' Microsoft connection regardless of the app-configured fetch result", async () => {
    const fetchSpy = mockFetchConnections([pendingMicrosoftConnection], { microsoft: false });

    render(<SettingsIntegrations />);

    await waitFor(() => {
      expect(screen.getByText("Setup in progress")).toBeInTheDocument();
    });

    expect(screen.queryByText("App not configured")).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  // The component resolves the app-configured fetch via the same microtask-deferred
  // effect pattern as ConnectedApps (see fetchAppConfigured below), and our fetch mock
  // resolves synchronously-enough within a microtask that there is no observable
  // intermediate frame where an active connection renders neither "Connected" nor
  // "App not configured" before settling. We therefore don't assert a loading state
  // here — forcing one would require an artificial unresolved-promise test double
  // that doesn't reflect real fetch timing.

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a stale app-configured response that resolves after a fresher one", async () => {
    vi.useFakeTimers();

    // A perpetually-pending Microsoft connection keeps the poll loop alive so we
    // can force a second fetchAppConfigured call while the first is still in
    // flight, plus an always-active Microsoft connection whose app-configured
    // state is what we're racing.
    const everPendingConnection = { ...pendingMicrosoftConnection, id: "ms-poll-keepalive" };
    const activeConnection = { ...activeMicrosoftConnection, id: "ms-race-target" };

    // Every /api/settings/oauth call made before the poll tick (both this
    // component's own mount-time fetchAppConfigured call AND the sibling
    // ConnectedApps section's independent per-provider fetches) is held open
    // and reports the app as configured — the stale answer we must not let
    // win. Calls made after the poll tick resolve immediately with the fresh,
    // correct answer.
    let pollTriggered = false;
    const heldMountCalls: Array<() => void> = [];

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("/api/settings/oauth")) {
        const respond = (configured: boolean) =>
          ({
            ok: true,
            text: async () => JSON.stringify({ configured, clientId: "", connectionCount: 0 }),
            json: async () => ({ configured, clientId: "", connectionCount: 0 }),
          }) as unknown as Response;
        if (!pollTriggered) {
          return new Promise<Response>((resolve) => {
            heldMountCalls.push(() => resolve(respond(true)));
          });
        }
        return Promise.resolve(respond(false));
      }
      // /api/integrations — return a fresh array reference each call so the
      // connections-driven effect re-fires even though the content is stable.
      const body = [everPendingConnection, activeConnection];
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response);
    });

    render(<SettingsIntegrations />);

    // Wait for all three mount-time oauth-settings calls to have been issued
    // and held open: ConnectedApps' own provider=google and provider=microsoft
    // fetches, plus this component's fetchAppConfigured provider=microsoft
    // call (only microsoft, since only microsoft connections are in the list).
    await vi.waitFor(() => {
      expect(heldMountCalls.length).toBe(3);
    });

    // The poll tick re-fetches connections (new array reference), triggering a
    // fresh, faster fetchAppConfigured call while the mount-time calls are
    // still unresolved.
    pollTriggered = true;
    await vi.advanceTimersByTimeAsync(10_000);

    // The fresh, correct response has already resolved and applied.
    await vi.waitFor(() => {
      expect(screen.getByText("App not configured")).toBeInTheDocument();
    });

    // Now let the stale mount-time responses resolve, and explicitly flush the
    // resulting promise chain (fetch → apiGet's JSON parsing → Promise.all →
    // setAppConfigured → re-render) so a would-be clobber has every chance to
    // apply before we assert it didn't.
    heldMountCalls.forEach((resolve) => resolve());
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText("App not configured")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

describe("SettingsIntegrations — OAuth callback errors (persistent banner)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An OAuth connect failure is a PERMANENT, actionable config error that comes
  // back after a full-page redirect — it must live in the DOM until the user
  // dismisses it, not vanish with a ~4-second toast (AGENTS.md "Error And
  // Notification UI"; the token_exchange_failed toast is exactly what a user
  // missed on staging 2026-07-06).
  it("renders a persistent banner (NOT a toast) for token_exchange_failed, pointing at the Client Secret", async () => {
    mockFetchConnections([]);
    const { toast } = await import("sonner");
    render(<SettingsIntegrations oauthError="token_exchange_failed" />);
    expect(
      await screen.findByText(
        "Sign-in worked, but Pinchy couldn't finish connecting — double-check the Client Secret under Connected apps, then try again."
      )
    ).toBeInTheDocument();
    // Do not ALSO fire a toast for the same action (AGENTS.md: don't mix inline
    // and toast errors).
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("renders the profile_fetch_failed message in the banner", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="profile_fetch_failed" />);
    expect(
      await screen.findByText(
        "Could not fetch your account profile. Check that your OAuth app grants the required profile permission."
      )
    ).toBeInTheDocument();
  });

  it("renders the invalid_token_response message in the banner", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="invalid_token_response" />);
    expect(
      await screen.findByText(
        "Sign-in worked, but the provider sent back a response Pinchy couldn't read. Please try connecting again."
      )
    ).toBeInTheDocument();
  });

  it("renders the missing_refresh_token message in the banner", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="missing_refresh_token" />);
    expect(
      await screen.findByText(
        "Sign-in worked, but the provider didn't return the long-lived token Pinchy needs to keep the mailbox connected. Please try again and be sure to grant offline access."
      )
    ).toBeInTheDocument();
  });

  it("renders the reassuring consent_declined message in the banner", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="consent_declined" />);
    expect(
      await screen.findByText(
        "You didn't authorize the connection, so nothing changed. You can try again whenever you're ready."
      )
    ).toBeInTheDocument();
  });

  it("renders the provider_error message in the banner", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="provider_error" />);
    expect(
      await screen.findByText("The provider reported a problem during sign-in. Please try again.")
    ).toBeInTheDocument();
  });

  it("renders a generic banner message for unknown error codes", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="unknown_code" />);
    expect(await screen.findByText("OAuth connection failed.")).toBeInTheDocument();
  });

  it("dismisses the banner when the dismiss button is clicked", async () => {
    const user = userEvent.setup();
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="token_exchange_failed" />);
    const message =
      "Sign-in worked, but Pinchy couldn't finish connecting — double-check the Client Secret under Connected apps, then try again.";
    expect(await screen.findByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });
  });

  it("renders no error banner when there is no oauthError", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations />);
    await waitFor(() => {
      // No alert region at all when there's no error — not just the specific
      // message string. Guards against an empty/generic banner regressing in.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/couldn't finish connecting/i)).not.toBeInTheDocument();
    });
  });

  // The banner replaced the toast for EVERY OAuth error code — assert no code
  // re-introduces a toast (double-signal, AGENTS.md "don't mix inline + toast").
  // Broadens the single token_exchange_failed guard above to the whole set.
  it.each([
    "token_exchange_failed",
    "profile_fetch_failed",
    "invalid_token_response",
    "missing_refresh_token",
    "consent_declined",
    "provider_error",
    "unknown_code",
  ])("shows the banner but fires no toast for oauthError=%s", async (code) => {
    mockFetchConnections([]);
    const { toast } = await import("sonner");
    render(<SettingsIntegrations oauthError={code} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  // A ~4s toast that fired after the redirect could at least be announced by a
  // screen reader's toast live region. A statically-rendered role="alert" that
  // is already in the DOM at first paint is NOT reliably announced (SRs announce
  // an alert region on mutation, not on initial render). So for a permanent,
  // actionable error that lands after a full-page redirect we move focus to the
  // banner — the GOV.UK / WCAG error-summary pattern — which guarantees the SR
  // reads it, independent of live-region timing. This is a justified departure
  // from the ambient insecure/enterprise info banners (which never grab focus).
  it("moves focus to the error banner on mount so screen readers announce it after the redirect", async () => {
    mockFetchConnections([]);
    render(<SettingsIntegrations oauthError="token_exchange_failed" />);
    const banner = await screen.findByRole("alert");
    await waitFor(() => expect(banner).toHaveFocus());
  });
});
