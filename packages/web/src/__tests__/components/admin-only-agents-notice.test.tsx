// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AdminOnlyAgentsNotice } from "@/components/admin-only-agents-notice";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { toast } from "sonner";

const twoAgents = [
  { id: "a1", name: "Sales Bot" },
  { id: "a2", name: "HR Bot" },
];

describe("AdminOnlyAgentsNotice", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders nothing when every shared agent has someone to use it", () => {
    const { container } = render(
      <AdminOnlyAgentsNotice agents={[]} licenseActive onOpened={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("with a license, says members can't see these agents and links each to its Access tab", () => {
    render(<AdminOnlyAgentsNotice agents={twoAgents} licenseActive onOpened={vi.fn()} />);

    expect(screen.getByText("2 shared agents only admins can use")).toBeInTheDocument();
    expect(screen.getByText(/members don't see them/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales Bot" })).toHaveAttribute(
      "href",
      "/chat/a1/settings?tab=access"
    );
    expect(screen.getByRole("link", { name: "HR Bot" })).toHaveAttribute(
      "href",
      "/chat/a2/settings?tab=access"
    );
  });

  it("uses the singular for one agent", () => {
    render(<AdminOnlyAgentsNotice agents={[twoAgents[0]]} licenseActive onOpened={vi.fn()} />);
    expect(screen.getByText("1 shared agent only admins can use")).toBeInTheDocument();
    expect(
      screen.getByText(/it's set to restricted with no group, so members don't see it/i)
    ).toBeInTheDocument();
  });

  it("without a license, warns ahead of activation and offers no bulk action", () => {
    render(<AdminOnlyAgentsNotice agents={twoAgents} licenseActive={false} onOpened={vi.fn()} />);

    expect(screen.getByText("2 shared agents have no group yet")).toBeInTheDocument();
    expect(
      screen.getByText(/once a license is active, only admins can use them/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /visible to everyone/i })).not.toBeInTheDocument();
  });

  it("asks before widening access, naming every agent, and only then posts", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    fetchSpy.mockResolvedValue(jsonResponse({ agents: twoAgents }));
    render(<AdminOnlyAgentsNotice agents={twoAgents} licenseActive onOpened={onOpened} />);

    await user.click(screen.getByRole("button", { name: "Make visible to everyone" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Make 2 agents visible to everyone?");
    expect(dialog).toHaveTextContent("Sales Bot");
    expect(dialog).toHaveTextContent("HR Bot");
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Make visible" }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(twoAgents));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agents/admin-only/open-to-all");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ agentIds: ["a1", "a2"] });
    expect(toast.success).toHaveBeenCalledWith("2 agents are now visible to everyone.");
  });

  it("says nothing changed when every agent had already moved on", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    fetchSpy.mockResolvedValue(jsonResponse({ agents: [] }));
    render(<AdminOnlyAgentsNotice agents={twoAgents} licenseActive onOpened={onOpened} />);

    await user.click(screen.getByRole("button", { name: "Make visible to everyone" }));
    await user.click(await screen.findByRole("button", { name: "Make visible" }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith([]));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Nothing to change — these agents were already updated. The list is refreshed."
    );
  });

  it("sends more than 200 agents in batches the API accepts", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `a${i}`, name: `Agent ${i}` }));
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { agentIds } = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({ agents: agentIds.map((id: string) => ({ id, name: id })) });
    });
    render(<AdminOnlyAgentsNotice agents={many} licenseActive onOpened={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Make visible to everyone" }));
    await user.click(await screen.findByRole("button", { name: "Make visible" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const sizes = fetchSpy.mock.calls.map(
      ([, init]: unknown[]) => JSON.parse((init as RequestInit).body as string).agentIds.length
    );
    expect(sizes).toEqual([200, 50]);
    expect(toast.success).toHaveBeenCalledWith("250 agents are now visible to everyone.");
  });

  it("uses the singular in the community notice and does not link to a locked tab", () => {
    render(
      <AdminOnlyAgentsNotice agents={[twoAgents[0]]} licenseActive={false} onOpened={vi.fn()} />
    );
    expect(screen.getByText("1 shared agent has no group yet")).toBeInTheDocument();
    expect(screen.getByText(/everyone can use it today/i)).toBeInTheDocument();
    expect(screen.getByText("Sales Bot")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sales Bot" })).not.toBeInTheDocument();
  });

  it("surfaces a failure and leaves the list in place", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Enterprise feature" }, { status: 403 }));
    render(<AdminOnlyAgentsNotice agents={twoAgents} licenseActive onOpened={onOpened} />);

    await user.click(screen.getByRole("button", { name: "Make visible to everyone" }));
    await user.click(await screen.findByRole("button", { name: "Make visible" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Enterprise feature"));
    expect(onOpened).not.toHaveBeenCalled();
  });
});
