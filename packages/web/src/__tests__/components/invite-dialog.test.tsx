import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { InviteDialog } from "@/components/invite-dialog";

// Mock window.location.origin for invite link generation
Object.defineProperty(window, "location", {
  value: { origin: "http://localhost:7777" },
  writable: true,
});

function resolveUrl(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
}

function mockFetchForInvite(
  inviteResponse: { ok: boolean; json: () => Promise<unknown> },
  options?: { enterprise?: boolean; groups?: { id: string; name: string }[] }
) {
  const enterprise = options?.enterprise ?? false;
  const groups = options?.groups ?? [];
  return (url: string | URL | Request) => {
    const urlStr = resolveUrl(url);
    if (urlStr.includes("/api/enterprise/status")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ enterprise }),
      } as Response);
    }
    if (urlStr.includes("/api/groups")) {
      return Promise.resolve({
        ok: true,
        json: async () => groups,
      } as Response);
    }
    return Promise.resolve(inviteResponse as Response);
  };
}

describe("InviteDialog", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementation(mockFetchForInvite({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render dialog with email and role fields when open", () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    expect(
      screen.getByText("Invite User", { selector: "[data-slot='dialog-title']" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Invite" })).toBeInTheDocument();
  });

  it("should show Member as default role", () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    const selectValue = screen.getByText("Member", { selector: "[data-slot='select-value']" });
    expect(selectValue).toBeInTheDocument();
  });

  it("should submit form with default values when Create Invite is clicked", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "test-token" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "", role: "member" }),
      });
    });
  });

  it("should submit form with entered email", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "test-token" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Email (optional)"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", role: "member" }),
      });
    });
  });

  it("should show invite link after successful creation", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "invite-token-abc" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/invite-token-abc")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("should show error message on API failure", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: false, json: async () => ({ error: "Invite limit reached" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("Invite limit reached")).toBeInTheDocument();
    });
  });

  it("should show generic error on network failure", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = resolveUrl(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: false }),
        } as Response);
      }
      return Promise.reject(new Error("Network error"));
    });

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to create invite")).toBeInTheDocument();
    });
  });

  it("should show validation error for invalid email", async () => {
    const user = userEvent.setup();

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Email (optional)"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalledWith("/api/users/invite", expect.anything());
  });

  it("should show Share button when Web Share API is available", async () => {
    const user = userEvent.setup();

    // Mock navigator.share as available
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      value: shareMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, "canShare", {
      value: () => true,
      writable: true,
      configurable: true,
    });

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "share-token" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/share-token")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(shareMock).toHaveBeenCalledWith({
      title: "Pinchy Invite",
      url: "http://localhost:7777/invite/share-token",
    });

    // Cleanup
    // @ts-expect-error cleaning up mock
    delete navigator.share;
    // @ts-expect-error cleaning up mock
    delete navigator.canShare;
  });

  it("should show Copy button when Web Share API is not available", async () => {
    const user = userEvent.setup();

    // Ensure navigator.share is NOT available
    const originalShare = navigator.share;
    // @ts-expect-error removing for test
    delete navigator.share;

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "copy-token" }) })
    );

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/copy-token")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();

    // Restore
    if (originalShare) navigator.share = originalShare;
  });

  it("shows group checkboxes when enterprise is enabled", async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: true }),
        } as Response);
      }
      if (urlStr.includes("/api/groups")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "g1", name: "HR" },
            { id: "g2", name: "Engineering" },
          ],
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "test" }),
      } as Response);
    });

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Groups")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("HR")).toBeInTheDocument();
    expect(screen.getByLabelText("Engineering")).toBeInTheDocument();
  });

  it("does not show group checkboxes when enterprise is disabled", async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: false }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "test" }),
      } as Response);
    });

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    // Wait a tick to let effects run
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create Invite" })).toBeInTheDocument();
    });

    expect(screen.queryByText("Groups")).not.toBeInTheDocument();
  });

  it("includes selected groupIds in invite request", async () => {
    const user = userEvent.setup();

    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: true }),
        } as Response);
      }
      if (urlStr.includes("/api/groups")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "g1", name: "HR" },
            { id: "g2", name: "Engineering" },
          ],
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "test-token" }),
      } as Response);
    });

    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    // Wait for groups to load
    await waitFor(() => {
      expect(screen.getByLabelText("HR")).toBeInTheDocument();
    });

    // Check the HR checkbox
    await user.click(screen.getByLabelText("HR"));

    // Submit the form
    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "",
          role: "member",
          groupIds: ["g1"],
        }),
      });
    });
  });

  it("refetches groups each time dialog opens", async () => {
    // First open: no groups yet
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = resolveUrl(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: true }),
        } as Response);
      }
      if (urlStr.includes("/api/groups")) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "test" }),
      } as Response);
    });

    const { rerender } = render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    // Wait for effects to settle
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create Invite" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Groups")).not.toBeInTheDocument();

    // Close dialog
    rerender(<InviteDialog open={false} onOpenChange={vi.fn()} />);

    // Now groups exist — update mock
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = resolveUrl(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: true }),
        } as Response);
      }
      if (urlStr.includes("/api/groups")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "g1", name: "Engineering" }],
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ token: "test" }),
      } as Response);
    });

    // Reopen dialog
    rerender(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    // Groups should now be visible without a page reload
    await waitFor(() => {
      expect(screen.getByText("Groups")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Engineering")).toBeInTheDocument();
  });

  it("should reset form when dialog closes and reopens", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    fetchSpy.mockImplementation(
      mockFetchForInvite({ ok: true, json: async () => ({ token: "test-token" }) })
    );

    const { rerender } = render(<InviteDialog open={true} onOpenChange={onOpenChange} />);

    // Type an email and create invite
    await user.type(screen.getByLabelText("Email (optional)"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Create Invite" }));

    await waitFor(() => {
      expect(screen.getByText("http://localhost:7777/invite/test-token")).toBeInTheDocument();
    });

    // Close dialog
    rerender(<InviteDialog open={false} onOpenChange={onOpenChange} />);

    // Reopen dialog
    rerender(<InviteDialog open={true} onOpenChange={onOpenChange} />);

    // Should be back to form state, not link state
    expect(screen.getByLabelText("Email (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Email (optional)")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create Invite" })).toBeInTheDocument();
  });
});
