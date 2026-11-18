// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConnectedApps } from "@/components/connected-apps";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { apiGet } from "@/lib/api-client";

interface OAuthAppState {
  configured: boolean;
  clientId: string;
  connectionCount: number;
}

// Route apiGet by the provider query param: Google is never configured in
// these tests (so only the Microsoft row renders), and Microsoft's
// connectionCount is supplied per test.
function mockProviderStates(microsoft: OAuthAppState) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.includes("provider=microsoft")) return microsoft as never;
    return { configured: false, clientId: "", connectionCount: 0 } as never;
  });
}

async function openResetDialog() {
  render(<ConnectedApps />);
  const resetButton = await screen.findByRole("button", { name: "Reset" });
  await userEvent.click(resetButton);
  return screen.findByRole("alertdialog");
}

describe("ConnectedApps reset confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not claim to disconnect anything when no integrations are connected", async () => {
    mockProviderStates({ configured: true, clientId: "ms-client-id", connectionCount: 0 });

    const dialog = await openResetDialog();

    // The nonsensical "disconnect 0 connected integrations ... must be
    // reconnected" copy must not appear for an app with no connections.
    expect(dialog).not.toHaveTextContent(/disconnect 0/i);
    expect(dialog).not.toHaveTextContent(/must be reconnected/i);
    expect(dialog).toHaveTextContent(/clears its stored credentials/i);
    expect(dialog).toHaveTextContent(/nothing is disconnected/i);
    expect(dialog).toHaveTextContent(/can't be undone/i);
  });

  it("warns about the single connected integration in the singular", async () => {
    mockProviderStates({ configured: true, clientId: "ms-client-id", connectionCount: 1 });

    const dialog = await openResetDialog();

    expect(dialog).toHaveTextContent(
      /will disconnect 1 connected integration\. They must be reconnected/i
    );
    expect(dialog).not.toHaveTextContent(/integrations\./i);
  });

  it("warns about multiple connected integrations in the plural", async () => {
    mockProviderStates({ configured: true, clientId: "ms-client-id", connectionCount: 3 });

    const dialog = await openResetDialog();

    expect(dialog).toHaveTextContent(
      /will disconnect 3 connected integrations\. They must be reconnected/i
    );
  });
});
