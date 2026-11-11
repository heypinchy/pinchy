// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("@/components/knowledge-folder-tree", () => ({
  KnowledgeFolderTree: ({ agentId }: { agentId: string }) => (
    <div data-testid="folder-tree">{agentId}</div>
  ),
}));

import { KnowledgeSearchSheet } from "@/components/knowledge-search-sheet";

describe("KnowledgeSearchSheet", () => {
  it("opens the agent's folder tree under a plain question", async () => {
    render(<KnowledgeSearchSheet agentId="agent-3" />);

    // Mounted only once opened, so a chat page does not poll the index for
    // a view nobody looked at.
    expect(screen.queryByTestId("folder-tree")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "What can this agent search?" }));

    expect(
      await screen.findByRole("dialog", { name: "What can this agent search?" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("folder-tree")).toHaveTextContent("agent-3");
  });
});
