import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SettingsPage from "@/app/(app)/settings/page";

let capturedProviderProps: {
  onSuccess?: () => void;
  submitLabel?: string;
  configuredProviders?: Record<string, { configured: boolean }>;
  defaultProvider?: string | null;
} = {};

vi.mock("@/components/provider-key-form", () => ({
  ProviderKeyForm: (props: {
    onSuccess: () => void;
    submitLabel?: string;
    configuredProviders?: Record<string, { configured: boolean }>;
    defaultProvider?: string | null;
  }) => {
    capturedProviderProps = props;
    return (
      <button onClick={props.onSuccess} data-testid="mock-provider-form">
        {props.submitLabel || "Continue"}
      </button>
    );
  },
}));

vi.mock("@/components/settings-users", () => ({
  SettingsUsers: ({ currentUserId }: { currentUserId: string }) => (
    <div data-testid="mock-settings-users">Users (currentUserId: {currentUserId})</div>
  ),
}));

vi.mock("@/components/settings-context", () => ({
  SettingsContext: ({
    userContext,
    orgContext,
    isAdmin,
  }: {
    userContext: string;
    orgContext: string;
    isAdmin: boolean;
  }) => (
    <div data-testid="mock-settings-context">
      Context (isAdmin: {String(isAdmin)}, userContext: {userContext}, orgContext: {orgContext})
    </div>
  ),
}));

vi.mock("@/components/settings-profile", () => ({
  SettingsProfile: ({ userName }: { userName: string }) => (
    <div data-testid="mock-settings-profile">Profile (userName: {userName})</div>
  ),
}));

const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

describe("Settings Page", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const adminSession = {
    data: {
      user: { id: "admin-1", name: "Admin Alice", role: "admin" },
    },
    status: "authenticated",
  };

  const userSession = {
    data: {
      user: { id: "user-1", name: "Regular Bob", role: "user" },
    },
    status: "authenticated",
  };

  function mockContextFetches() {
    return {
      ok: true,
      json: async () => ({ content: "" }),
    } as Response;
  }

  function setupAdminFetchMocks(providerData?: object) {
    const pd = providerData ?? {
      defaultProvider: null,
      providers: {
        anthropic: { configured: false },
        openai: { configured: false },
        google: { configured: false },
      },
    };
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path === "/api/settings/providers") {
        return { ok: true, json: async () => pd } as Response;
      }
      if (path === "/api/users/me/context" || path === "/api/settings/context") {
        return mockContextFetches();
      }
      return { ok: false } as Response;
    });
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
    capturedProviderProps = {};
    mockUseSession.mockReturnValue(adminSession);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render the page title", async () => {
    setupAdminFetchMocks();

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });

  describe("Admin user", () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue(adminSession);
    });

    it("should render Provider, Users, Context, and Profile tabs", async () => {
      setupAdminFetchMocks();

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Provider" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Users" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Context" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Profile" })).toBeInTheDocument();
      });
    });

    it("should show Provider tab content by default for admin", async () => {
      setupAdminFetchMocks();

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText("LLM Provider")).toBeInTheDocument();
      });
    });

    it("should render LLM Provider section with ProviderKeyForm", async () => {
      setupAdminFetchMocks();

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId("mock-provider-form")).toBeInTheDocument();
      });
    });

    it("should show loading state while fetching provider status", () => {
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const path = typeof url === "string" ? url : url.toString();
        if (path === "/api/settings/providers") {
          return new Promise(() => {}) as unknown as Response;
        }
        return mockContextFetches();
      });

      render(<SettingsPage />);

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("should pass configuredProviders and defaultProvider to ProviderKeyForm after fetch", async () => {
      const providerData = {
        defaultProvider: "anthropic",
        providers: {
          anthropic: { configured: true },
          openai: { configured: false },
          google: { configured: false },
        },
      };

      setupAdminFetchMocks(providerData);

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId("mock-provider-form")).toBeInTheDocument();
      });

      expect(capturedProviderProps.configuredProviders).toEqual(providerData.providers);
      expect(capturedProviderProps.defaultProvider).toBe("anthropic");
    });

    it("should re-fetch provider status after onSuccess", async () => {
      setupAdminFetchMocks();

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId("mock-provider-form")).toBeInTheDocument();
      });

      capturedProviderProps.onSuccess!();

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/settings/providers");
      });
    });
  });

  describe("Regular user", () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue(userSession);
    });

    it("should show Context and Profile tabs but not Provider or Users", () => {
      vi.mocked(global.fetch).mockImplementation(async () => mockContextFetches());

      render(<SettingsPage />);

      expect(screen.getByRole("tab", { name: "Context" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Profile" })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Provider" })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Users" })).not.toBeInTheDocument();
    });

    it("should show Context tab content by default", () => {
      vi.mocked(global.fetch).mockImplementation(async () => mockContextFetches());

      render(<SettingsPage />);

      expect(screen.getByTestId("mock-settings-context")).toBeInTheDocument();
    });

    it("should fetch user context but not provider status", async () => {
      vi.mocked(global.fetch).mockImplementation(async () => mockContextFetches());

      render(<SettingsPage />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/users/me/context");
        expect(global.fetch).not.toHaveBeenCalledWith("/api/settings/providers");
      });
    });
  });
});
