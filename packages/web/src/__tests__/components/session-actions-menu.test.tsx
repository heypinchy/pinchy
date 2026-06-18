import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { SessionActionsMenu } from "@/components/session-actions-menu";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const text = JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

describe("SessionActionsMenu", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function openMenuAndCompact(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /conversation actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /compact/i }));
  }

  it("POSTs to the agent's compact endpoint and toasts success", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    render(<SessionActionsMenu agentId="agent-1" />);
    await openMenuAndCompact(user);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-1/sessions/compact");
    expect(opts.method).toBe("POST");

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("includes chatId in the request body when on a per-chat URL (#508)", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    render(<SessionActionsMenu agentId="agent-1" chatId="chat-abc" />);
    await openMenuAndCompact(user);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ chatId: "chat-abc" });
  });

  it("omits chatId from the body for the default chat", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    render(<SessionActionsMenu agentId="agent-1" />);
    await openMenuAndCompact(user);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({});
  });

  it("surfaces the server error message via toast.error on failure", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Failed to compact session" }, { ok: false, status: 502 })
    );

    render(<SessionActionsMenu agentId="agent-1" />);
    await openMenuAndCompact(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to compact session"));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
