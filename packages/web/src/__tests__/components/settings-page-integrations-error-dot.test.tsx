import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "u1", name: "Admin", email: "a@b.com", role: "admin" } },
      isPending: false,
    }),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ replace: vi.fn() }),
  useSearchParams: vi.fn().mockReturnValue(new URLSearchParams()),
  usePathname: vi.fn().mockReturnValue("/settings"),
}));

const mockUseIntegrationHealth = vi.fn();
vi.mock("@/hooks/use-integration-health", () => ({
  useIntegrationHealth: (...args: unknown[]) => mockUseIntegrationHealth(...args),
}));

vi.mock("@/components/settings-integrations", () => ({
  SettingsIntegrations: () => <div data-testid="settings-integrations" />,
}));
vi.mock("@/components/provider-key-form", () => ({ ProviderKeyForm: () => <div /> }));
vi.mock("@/components/settings-users", () => ({ SettingsUsers: () => <div /> }));
vi.mock("@/components/settings-groups", () => ({ SettingsGroups: () => <div /> }));
vi.mock("@/components/settings-license", () => ({ SettingsLicense: () => <div /> }));
vi.mock("@/components/telegram-link-settings", () => ({ TelegramLinkSettings: () => <div /> }));
vi.mock("@/components/settings-context", () => ({ SettingsContext: () => <div /> }));
vi.mock("@/components/settings-profile", () => ({ SettingsProfile: () => <div /> }));
vi.mock("@/components/settings-security", () => ({ SettingsSecurity: () => <div /> }));

import { SettingsPageContent } from "@/components/settings-page-content";

function getIntegrationsTab() {
  return screen.getByRole("tab", { name: /integrations/i });
}

describe("SettingsPageContent integrations tab error dot", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders an error dot on the Integrations tab when needsAttentionCount > 0", async () => {
    mockUseIntegrationHealth.mockReturnValue({ needsAttentionCount: 2 });
    render(<SettingsPageContent isAdmin={true} />);
    await waitFor(() => {
      expect(within(getIntegrationsTab()).getByLabelText(/needs? attention/i)).toBeInTheDocument();
    });
  });

  it("does not render an error dot when needsAttentionCount is 0", async () => {
    mockUseIntegrationHealth.mockReturnValue({ needsAttentionCount: 0 });
    render(<SettingsPageContent isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-integrations")).toBeInTheDocument();
    });
    expect(
      within(getIntegrationsTab()).queryByLabelText(/needs? attention/i)
    ).not.toBeInTheDocument();
  });

  it("passes isAdmin to useIntegrationHealth so non-admins don't poll", () => {
    mockUseIntegrationHealth.mockReturnValue({ needsAttentionCount: 0 });
    render(<SettingsPageContent isAdmin={false} />);
    expect(mockUseIntegrationHealth).toHaveBeenCalledWith(false);
  });
});
