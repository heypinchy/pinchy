// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { KnowledgeUnsearchableList } from "@/components/knowledge-unsearchable-list";
import { apiGet } from "@/lib/api-client";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});

const mockGet = vi.mocked(apiGet);

describe("KnowledgeUnsearchableList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ documents: [], total: 0 });
  });

  it("names the documents that can't be searched, by full path", async () => {
    mockGet.mockResolvedValue({
      documents: [
        { sourcePath: "/data/certs/AFNOR validation.pdf", status: "active" },
        { sourcePath: "/data/certs/NordVal certificate.pdf", status: "active" },
      ],
      total: 2,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText("/data/certs/AFNOR validation.pdf")).toBeInTheDocument()
    );
    expect(screen.getByText("/data/certs/NordVal certificate.pdf")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/api/agents/a1/knowledge/unsearchable");
  });

  // The whole point of the panel: a reader must learn that "nothing found" can
  // be a fact about the INDEX, not about the documents.
  it("says why it matters — the agent will answer 'nothing found' for these", async () => {
    mockGet.mockResolvedValue({
      documents: [{ sourcePath: "/data/certs/AFNOR validation.pdf", status: "active" }],
      total: 1,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/no searchable text/i)).toBeInTheDocument());
    expect(screen.getByText(/won't find anything in them/i)).toBeInTheDocument();
  });

  // This number counts the whole scope; the per-run counts it renders beside
  // only count what that run processed (an unchanged document is `skipped`, not
  // recounted). Naming the window is what stops "4 unsearchable" above "25
  // documents…" from reading as a contradiction — so it is asserted, not left
  // to survive the next copy edit by luck.
  it("names the window it is counting, so it can't be read against the run counts", async () => {
    mockGet.mockResolvedValue({
      documents: [{ sourcePath: "/data/certs/Scan.pdf", status: "active" }],
      total: 25,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/25 documents in this agent's folders/i)).toBeInTheDocument()
    );
  });

  it("reads as good news when every document has text", async () => {
    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/every document in this agent's folders/i)).toBeInTheDocument()
    );
    // Good news, not a warning: no alert role, nothing to act on.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  // Before a run has ever finished, "every document has searchable text" is
  // trivially true of an empty index and would sit right under "Not yet
  // indexed" — a reassurance about nothing.
  it("stays silent about zero when no run has finished yet", async () => {
    const { container } = render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // …but a corpus indexed by ANOTHER agent still shows up: the index is
  // corpus-wide, so this agent's scope can hold unsearchable documents without
  // this agent ever having run an index itself.
  it("lists documents even when this agent has never finished a run", async () => {
    mockGet.mockResolvedValue({
      documents: [{ sourcePath: "/data/certs/Scan.pdf", status: "active" }],
      total: 1,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);

    await waitFor(() => expect(screen.getByText("/data/certs/Scan.pdf")).toBeInTheDocument());
  });

  it("marks archived documents as archived", async () => {
    mockGet.mockResolvedValue({
      documents: [{ sourcePath: "/data/certs/OLD/Expired ISO.pdf", status: "archived" }],
      total: 1,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText("/data/certs/OLD/Expired ISO.pdf")).toBeInTheDocument()
    );
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  // A truncated list that doesn't say it's truncated understates exactly the
  // gap it exists to expose.
  it("says how many it is not showing when the list is capped", async () => {
    mockGet.mockResolvedValue({
      documents: [
        { sourcePath: "/data/certs/Scan 1.pdf", status: "active" },
        { sourcePath: "/data/certs/Scan 2.pdf", status: "active" },
      ],
      total: 25,
    });

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/showing 2 of 25/i)).toBeInTheDocument());
  });

  it("reloads when the reload key changes, and not otherwise", async () => {
    const { rerender } = render(
      <KnowledgeUnsearchableList agentId="a1" announceNone reloadKey="job-1:succeeded" />
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    rerender(<KnowledgeUnsearchableList agentId="a1" announceNone reloadKey="job-1:succeeded" />);
    expect(mockGet).toHaveBeenCalledTimes(1);

    rerender(<KnowledgeUnsearchableList agentId="a1" announceNone reloadKey="job-2:succeeded" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  // A failed read must not claim the corpus is clean: silence is the honest
  // answer, and the next reload retries.
  it("renders nothing when the read fails, rather than a false all-clear", async () => {
    mockGet.mockRejectedValue(new Error("network down"));

    const { container } = render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
