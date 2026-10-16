// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { MemberAccessSettings } from "@/components/member-access-settings";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("MemberAccessSettings", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });
  afterEach(() => fetchSpy.mockRestore());

  it("shows both switches as stored on the server", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({ memberPersonalAgents: true, memberAutomations: false })
    );

    render(<MemberAccessSettings />);

    const personal = await screen.findByRole("checkbox", { name: /use a personal agent/i });
    const automations = screen.getByRole("checkbox", { name: /create automations/i });
    expect(personal).toBeChecked();
    expect(automations).not.toBeChecked();
    expect(global.fetch).toHaveBeenCalledWith("/api/settings/governance", expect.anything());
  });

  it("saves both switches together and confirms with a toast", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ memberPersonalAgents: true, memberAutomations: true }))
      .mockResolvedValueOnce(
        jsonResponse({ memberPersonalAgents: false, memberAutomations: true })
      );
    const user = userEvent.setup();

    render(<MemberAccessSettings />);
    await user.click(await screen.findByRole("checkbox", { name: /use a personal agent/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [url, init] = vi.mocked(global.fetch).mock.calls[1];
    expect(url).toBe("/api/settings/governance");
    expect(init).toMatchObject({ method: "PUT" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      memberPersonalAgents: false,
      memberAutomations: true,
    });
  });

  it("disables the automations switch while personal agents are off — it cannot apply", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({ memberPersonalAgents: false, memberAutomations: true })
    );

    render(<MemberAccessSettings />);

    expect(await screen.findByRole("checkbox", { name: /create automations/i })).toBeDisabled();
  });

  it("shows the server's error inline when saving fails", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ memberPersonalAgents: true, memberAutomations: true }))
      .mockResolvedValueOnce(jsonResponse({ error: "Forbidden" }, { status: 403 }));
    const user = userEvent.setup();

    render(<MemberAccessSettings />);
    await user.click(await screen.findByRole("checkbox", { name: /create automations/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Forbidden")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
