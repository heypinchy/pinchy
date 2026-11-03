// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { KnowledgeUnsearchableList } from "@/components/knowledge-unsearchable-list";
import { apiGet } from "@/lib/api-client";
import { holdResults } from "@/test-helpers/hold-results";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});

const mockGet = vi.mocked(apiGet);

/** The route's response; every document a scan unless the test says otherwise. */
function response(
  documents: { sourcePath: string; status: "active" | "archived"; reason?: string }[],
  overrides: {
    total?: number;
    totals?: { no_text: number; awaiting_conversion: number };
    searchesIndex?: boolean;
  } = {}
) {
  const rows = documents.map((doc) => ({ reason: "no_text", ...doc }));
  const awaiting = rows.filter((doc) => doc.reason === "awaiting_conversion").length;
  const total = overrides.total ?? rows.length;
  return {
    documents: rows,
    total,
    totals: overrides.totals ?? { no_text: total - awaiting, awaiting_conversion: awaiting },
    searchesIndex: overrides.searchesIndex ?? true,
  };
}

describe("KnowledgeUnsearchableList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(response([]));
  });

  it("names the documents that can't be searched, by full path", async () => {
    mockGet.mockResolvedValue(
      response([
        { sourcePath: "/data/certs/AFNOR validation.pdf", status: "active" },
        { sourcePath: "/data/certs/NordVal certificate.pdf", status: "active" },
      ])
    );

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
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/AFNOR validation.pdf", status: "active" }])
    );

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
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/Scan.pdf", status: "active" }], { total: 25 })
    );

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
    const load = holdResults();
    mockGet.mockImplementation(() => load.resolveWith({ documents: [], total: 0 }));
    const { container } = render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);

    await load.release();
    expect(container).toBeEmptyDOMElement();
  });

  // …but a corpus indexed by ANOTHER agent still shows up: the index is
  // corpus-wide, so this agent's scope can hold unsearchable documents without
  // this agent ever having run an index itself.
  it("lists documents even when this agent has never finished a run", async () => {
    mockGet.mockResolvedValue(response([{ sourcePath: "/data/certs/Scan.pdf", status: "active" }]));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);

    await waitFor(() => expect(screen.getByText("/data/certs/Scan.pdf")).toBeInTheDocument());
  });

  it("marks archived documents as archived", async () => {
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/OLD/Expired ISO.pdf", status: "archived" }])
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText("/data/certs/OLD/Expired ISO.pdf")).toBeInTheDocument()
    );
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  // Such a document has text, so "holds no searchable text" alone would send
  // an admin looking at the wrong problem.
  it("marks a document search leaves out until it is converted again, and says why", async () => {
    mockGet.mockResolvedValue(
      response([
        {
          sourcePath: "/data/offers/Angebot.docx",
          status: "active",
          reason: "awaiting_conversion",
        },
        { sourcePath: "/data/offers/Scan.pdf", status: "active", reason: "no_text" },
      ])
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText("/data/offers/Angebot.docx")).toBeInTheDocument());
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/waiting to be converted again/i);
    expect(items[1]).not.toHaveTextContent(/converted again/i);
    expect(screen.getByText(/search leaves it out until then/i)).toBeInTheDocument();
  });

  // A file waiting to be converted again HAS text. Counting it into "hold no
  // searchable text — nearly always scans" would send an admin looking for a
  // vision model that would change nothing for it.
  it("counts only the documents without text as having no searchable text", async () => {
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/Scan.pdf", status: "active" }], {
        total: 5,
        totals: { no_text: 3, awaiting_conversion: 2 },
      })
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /3 documents in this agent's folders are indexed but hold no searchable text/i
        )
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/5 documents/i)).not.toBeInTheDocument();
  });

  // The list is capped and sorted by path, so the files waiting to be
  // converted can all sit past the first page. The count comes from the
  // route's per-reason total, never from the rows that happen to be shown.
  it("says how many files wait to be converted again, even when none of them is on the page", async () => {
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/Scan.pdf", status: "active" }], {
        total: 3,
        totals: { no_text: 1, awaiting_conversion: 2 },
      })
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /2 Word or PowerPoint files in this agent's folders are waiting to be converted again/i
        )
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/search leaves them out until then/i)).toBeInTheDocument();
  });

  it("doesn't talk about scans when every listed file only waits to be converted again", async () => {
    mockGet.mockResolvedValue(
      response([
        {
          sourcePath: "/data/offers/Angebot.docx",
          status: "active",
          reason: "awaiting_conversion",
        },
      ])
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText("/data/offers/Angebot.docx")).toBeInTheDocument());
    expect(screen.queryByText(/no searchable text/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scans/i)).not.toBeInTheDocument();
  });

  // Pinchy queues the conversion run on its own only for an agent that
  // searches the index (office-format-upgrade.ts); for any other agent, only a
  // reindex converts these files.
  it("says Pinchy converts them on its own for an agent that searches the index", async () => {
    mockGet.mockResolvedValue(
      response(
        [
          {
            sourcePath: "/data/offers/Angebot.docx",
            status: "active",
            reason: "awaiting_conversion",
          },
        ],
        { searchesIndex: true }
      )
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/Pinchy converts it again on its own/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/a reindex converts/i)).not.toBeInTheDocument();
  });

  it("says a reindex converts them for an agent that doesn't search the index", async () => {
    mockGet.mockResolvedValue(
      response(
        [
          {
            sourcePath: "/data/offers/Angebot.docx",
            status: "active",
            reason: "awaiting_conversion",
          },
        ],
        { searchesIndex: false }
      )
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/a reindex converts it/i)).toBeInTheDocument());
    expect(screen.queryByText(/on its own/i)).not.toBeInTheDocument();
  });

  it("says nothing about conversion when no listed document is waiting for one", async () => {
    mockGet.mockResolvedValue(
      response([{ sourcePath: "/data/certs/Scan.pdf", status: "active", reason: "no_text" }])
    );

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText("/data/certs/Scan.pdf")).toBeInTheDocument());
    expect(screen.queryByText(/converted again/i)).not.toBeInTheDocument();
  });

  // A truncated list that doesn't say it's truncated understates exactly the
  // gap it exists to expose.
  it("says how many it is not showing when the list is capped", async () => {
    mockGet.mockResolvedValue(
      response(
        [
          { sourcePath: "/data/certs/Scan 1.pdf", status: "active" },
          { sourcePath: "/data/certs/Scan 2.pdf", status: "active" },
        ],
        { total: 25 }
      )
    );

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
    // A swallowed rejection commits nothing, so there is no render to wait
    // for: the release itself is the signal.
    const read = holdResults();
    mockGet.mockImplementation(() => read.rejectWith(new Error("network down")));

    const { container } = render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    expect(mockGet).toHaveBeenCalled();
    await read.release();
    expect(container).toBeEmptyDOMElement();
  });
});
