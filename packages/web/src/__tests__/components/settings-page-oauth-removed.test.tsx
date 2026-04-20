import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: { id: "u1", name: "Admin", email: "a@b.com", role: "admin" },
      },
      isPending: false,
    }),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ replace: vi.fn() }),
  useSearchParams: vi.fn().mockReturnValue(new URLSearchParams()),
  usePathname: vi.fn().mockReturnValue("/settings"),
}));

vi.mock("@/components/settings-integrations", () => ({
  SettingsIntegrations: () => <div data-testid="settings-integrations" />,
}));

vi.mock("@/components/settings-oauth", () => ({
  SettingsOAuth: () => <div data-testid="settings-oauth">OAuth Providers</div>,
}));

vi.mock("@/components/provider-key-form", () => ({
  ProviderKeyForm: () => <div />,
}));
vi.mock("@/components/settings-users", () => ({
  SettingsUsers: () => <div />,
}));
vi.mock("@/components/settings-groups", () => ({
  SettingsGroups: () => <div />,
}));
vi.mock("@/components/settings-license", () => ({
  SettingsLicense: () => <div />,
}));
vi.mock("@/components/telegram-link-settings", () => ({
  TelegramLinkSettings: () => <div />,
}));
vi.mock("@/components/settings-context", () => ({
  SettingsContext: () => <div />,
}));
vi.mock("@/components/settings-profile", () => ({
  SettingsProfile: () => <div />,
}));
vi.mock("@/components/settings-security", () => ({
  SettingsSecurity: () => <div />,
}));

import { SettingsPageContent } from "@/components/settings-page-content";

describe("SettingsPageContent integrations tab", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("does not render SettingsOAuth component", async () => {
    render(<SettingsPageContent initialTab="integrations" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-integrations")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("settings-oauth")).not.toBeInTheDocument();
  });
});
