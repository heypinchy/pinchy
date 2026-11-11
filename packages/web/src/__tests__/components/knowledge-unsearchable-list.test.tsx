// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { KnowledgeUnsearchableList } from "@/components/knowledge-unsearchable-list";
import { apiGet } from "@/lib/api-client";
import { holdResults } from "@/test-helpers/hold-results";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});

const mockGet = vi.mocked(apiGet);

const URL = "/api/agents/a1/knowledge/unsearchable";

type Cause = "ocr_off" | "no_vision_model" | "read_next_run" | "read_blank";
type Group = { root: string; folder: string | null; count: number };
type Doc = {
  sourcePath: string;
  name: string;
  root: string;
  folder: string;
  status: "active" | "archived";
  reason: "no_text" | "awaiting_conversion";
  cause: Cause | null;
};

/** The route's summary. Every no-text document has `cause` unless the test says otherwise. */
function summary(
  overrides: {
    noText?: number;
    awaiting?: number;
    causes?: Partial<Record<Cause, number>>;
    groups?: Group[];
    searchesIndex?: boolean;
  } = {}
) {
  const noText = overrides.noText ?? 0;
  const awaiting = overrides.awaiting ?? 0;
  const total = noText + awaiting;
  return {
    total,
    totals: { no_text: noText, awaiting_conversion: awaiting },
    causes: {
      ocr_off: 0,
      no_vision_model: 0,
      read_next_run: 0,
      read_blank: 0,
      ...(overrides.causes ?? { no_vision_model: noText }),
    },
    groups:
      overrides.groups ?? (total > 0 ? [{ root: "/data/certs", folder: null, count: total }] : []),
    searchesIndex: overrides.searchesIndex ?? true,
  };
}

function doc(overrides: Partial<Doc>): Doc {
  return {
    sourcePath: "/data/certs/Scan.pdf",
    name: "Scan.pdf",
    root: "/data/certs",
    folder: "",
    status: "active",
    reason: "no_text",
    cause: "no_vision_model",
    ...overrides,
  };
}

/** Answers the summary at the bare URL and each group's documents at its query. */
function serve(
  sum: ReturnType<typeof summary>,
  groups: Record<string, { documents: Doc[]; total?: number }> = {}
) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === URL) return sum;
    const query = url.slice(URL.length);
    const page = groups[query];
    if (!page) throw new Error(`unexpected request ${url}`);
    return { documents: page.documents, total: page.total ?? page.documents.length };
  });
}

const groupQuery = (root: string, folder?: string) =>
  `?root=${encodeURIComponent(root)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;

describe("KnowledgeUnsearchableList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve(summary());
  });

  // Thousands of documents (#1364): the count leads, the list waits behind it.
  it("keeps the list collapsed behind the count until asked", async () => {
    serve(summary({ noText: 2 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    const toggle = await screen.findByRole("button", { name: /show the 2 documents/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(URL);
  });

  // The file name is what an admin recognizes; the folder is where to look.
  it("names each document by file name first, with its folder beside it", async () => {
    serve(summary({ noText: 2, groups: [{ root: "/data/certs", folder: "Food", count: 2 }] }), {
      [groupQuery("/data/certs", "Food")]: {
        documents: [
          doc({
            sourcePath: "/data/certs/Food/2024/AFNOR validation.pdf",
            name: "AFNOR validation.pdf",
            folder: "Food/2024",
          }),
          doc({
            sourcePath: "/data/certs/Food/NordVal certificate.pdf",
            name: "NordVal certificate.pdf",
            folder: "Food",
          }),
        ],
      },
    });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the 2 documents/i }));

    const item = (await screen.findByText("AFNOR validation.pdf")).closest("li")!;
    expect(within(item).getByText("Food/2024")).toBeInTheDocument();
    expect(screen.getByText("NordVal certificate.pdf")).toBeInTheDocument();
    // Never the mount point: the path below the grant is all an admin needs.
    expect(screen.queryByText(/\/data\/certs/)).not.toBeInTheDocument();
  });

  it("groups the documents by folder, with a count per folder, and loads a folder when opened", async () => {
    serve(
      summary({
        noText: 21,
        groups: [
          { root: "/data/certs", folder: "Food", count: 19 },
          { root: "/data/certs", folder: null, count: 2 },
        ],
      }),
      {
        [groupQuery("/data/certs", "Food")]: {
          documents: [doc({ sourcePath: "/data/certs/Food/A.pdf", name: "A.pdf", folder: "Food" })],
        },
      }
    );
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the 21 documents/i }));

    const food = screen.getByRole("button", { name: /Food.*19/ });
    expect(food).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /directly in certs.*2/i })).toBeInTheDocument();
    // Nothing loads for a folder nobody opened.
    expect(mockGet).toHaveBeenCalledTimes(1);

    await user.click(food);

    expect(await screen.findByText("A.pdf")).toBeInTheDocument();
    expect(food).toHaveAttribute("aria-expanded", "true");
    expect(mockGet).toHaveBeenLastCalledWith(URL + groupQuery("/data/certs", "Food"));
  });

  it("opens the only folder there is right away", async () => {
    serve(summary({ noText: 1 }), {
      [groupQuery("/data/certs")]: { documents: [doc({})] },
    });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the document/i }));

    expect(await screen.findByText("Scan.pdf")).toBeInTheDocument();
  });

  // Two grants can hold folders of the same name.
  it("names the granted folder too when the agent has more than one", async () => {
    serve(
      summary({
        noText: 3,
        groups: [
          { root: "/data/hr", folder: "2024", count: 2 },
          { root: "/data/legal", folder: "2024", count: 1 },
        ],
      })
    );
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the 3 documents/i }));

    expect(screen.getByRole("button", { name: /hr\/2024.*2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /legal\/2024.*1/ })).toBeInTheDocument();
  });

  // The page shows a hundred per folder; the download is the whole list.
  it("offers the whole list as a CSV download", async () => {
    serve(summary({ noText: 2 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    const link = await screen.findByRole("link", { name: /download the list/i });
    expect(link).toHaveAttribute("href", `${URL}/csv`);
    expect(link).toHaveAttribute("download");
  });

  // A truncated folder that doesn't say it's truncated understates exactly
  // the gap this exists to expose — and says where the rest is.
  it("says how many of a folder it is showing, and that the download has all of them", async () => {
    serve(summary({ noText: 250 }), {
      [groupQuery("/data/certs")]: { documents: [doc({})], total: 250 },
    });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the 250 documents/i }));

    expect(
      await screen.findByText(/showing 1 of 250.*the download has all of them/i)
    ).toBeInTheDocument();
  });

  // The whole point of the panel: a reader must learn that "nothing found" can
  // be a fact about the INDEX, not about the documents.
  it("says why it matters — the agent will answer 'nothing found' for these", async () => {
    serve(summary({ noText: 1 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/no searchable text/i)).toBeInTheDocument());
    expect(screen.getByText(/won't find anything in them/i)).toBeInTheDocument();
  });

  // This number counts the whole scope; the per-run counts it renders beside
  // only count what that run processed. Naming the window is what stops "4
  // unsearchable" above "25 documents…" from reading as a contradiction.
  it("names the window it is counting, so it can't be read against the run counts", async () => {
    serve(summary({ noText: 25 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/25 documents in this agent's folders/i)).toBeInTheDocument()
    );
  });

  // #1362: with OCR switched off, "no vision model was available" sends an
  // admin to configure a model that would change nothing.
  it("says reading scans is switched off when it is, and doesn't blame a vision model", async () => {
    serve(summary({ noText: 4, causes: { ocr_off: 4 } }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/reading scans is switched off on this server/i)).toBeInTheDocument()
    );
    expect(screen.getByText("PINCHY_KB_OCR")).toBeInTheDocument();
    expect(screen.getByText(/once it's switched on, the next run reads them/i)).toBeInTheDocument();
    expect(screen.queryByText(/vision model/i)).not.toBeInTheDocument();
  });

  it("says a vision model is missing when reading scans is on but none is available", async () => {
    serve(summary({ noText: 1, causes: { no_vision_model: 1 } }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/no vision model is available to read scans/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/make one available and the next run reads it/i)).toBeInTheDocument();
    expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
  });

  it("says the next run reads a scan a vision model hasn't read yet", async () => {
    serve(summary({ noText: 2, causes: { read_next_run: 2 } }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/weren't read by a vision model yet/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/the next run reads them/i)).toBeInTheDocument();
  });

  // Read and still empty: nothing to configure, and saying so stops the hunt.
  it("says a document read in full holds no text, without promising another run", async () => {
    serve(summary({ noText: 1, causes: { read_blank: 1 } }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/was read in full and holds no text/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/next run/i)).not.toBeInTheDocument();
  });

  it("gives each cause its own share when the documents differ", async () => {
    serve(summary({ noText: 5, causes: { ocr_off: 3, read_blank: 2 } }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/3 of them can't be read yet/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/2 of them were read in full/i)).toBeInTheDocument();
  });

  it("hands the no-text count to the section, so its badge agrees with this list", async () => {
    const onNoTextCount = vi.fn();
    serve(summary({ noText: 3, awaiting: 2 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone onNoTextCount={onNoTextCount} />);

    await waitFor(() => expect(onNoTextCount).toHaveBeenCalledWith(3));
  });

  it("reads as good news when every document has text", async () => {
    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/every document in this agent's folders/i)).toBeInTheDocument()
    );
    // Good news, not a warning: no alert role, nothing to act on.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // Before a run has ever finished, "every document has searchable text" is
  // trivially true of an empty index and would sit right under "Not yet
  // indexed" — a reassurance about nothing.
  it("stays silent about zero when no run has finished yet", async () => {
    const load = holdResults();
    mockGet.mockImplementation(() => load.resolveWith(summary()));
    const { container } = render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);

    await load.release();
    expect(container).toBeEmptyDOMElement();
  });

  // …but a corpus indexed by ANOTHER agent still shows up: the index is
  // corpus-wide, so this agent's scope can hold unsearchable documents without
  // this agent ever having run an index itself.
  it("lists documents even when this agent has never finished a run", async () => {
    serve(summary({ noText: 1 }), { [groupQuery("/data/certs")]: { documents: [doc({})] } });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone={false} />);
    await user.click(await screen.findByRole("button", { name: /show the document/i }));

    expect(await screen.findByText("Scan.pdf")).toBeInTheDocument();
  });

  it("marks archived documents as archived", async () => {
    serve(summary({ noText: 1 }), {
      [groupQuery("/data/certs")]: {
        documents: [
          doc({
            sourcePath: "/data/certs/OLD/Expired ISO.pdf",
            name: "Expired ISO.pdf",
            folder: "OLD",
            status: "archived",
          }),
        ],
      },
    });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the document/i }));

    const item = (await screen.findByText("Expired ISO.pdf")).closest("li")!;
    expect(within(item).getByText(/archived/i)).toBeInTheDocument();
  });

  // Such a document has text, so "holds no searchable text" alone would send
  // an admin looking at the wrong problem.
  it("marks a document search leaves out until it is converted again, and says why", async () => {
    serve(summary({ noText: 1, awaiting: 1 }), {
      [groupQuery("/data/certs")]: {
        documents: [
          doc({
            sourcePath: "/data/certs/Angebot.docx",
            name: "Angebot.docx",
            reason: "awaiting_conversion",
            cause: null,
          }),
          doc({}),
        ],
      },
    });
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the 2 documents/i }));

    await screen.findByText("Angebot.docx");
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/waiting to be converted again/i);
    expect(items[1]).not.toHaveTextContent(/converted again/i);
    expect(screen.getByText(/search leaves it out until then/i)).toBeInTheDocument();
  });

  // A file waiting to be converted again HAS text. Counting it into "hold no
  // searchable text — nearly always scans" would send an admin looking for a
  // vision model that would change nothing for it.
  it("counts only the documents without text as having no searchable text", async () => {
    serve(summary({ noText: 3, awaiting: 2 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /3 documents in this agent's folders are indexed but hold no searchable text/i
        )
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/5 documents in/i)).not.toBeInTheDocument();
  });

  it("says how many files wait to be converted again, from the route's count", async () => {
    serve(summary({ noText: 1, awaiting: 2 }));

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
    serve(summary({ awaiting: 1 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/waiting to be converted again/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/no searchable text/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scans/i)).not.toBeInTheDocument();
  });

  // Pinchy queues the conversion run on its own only for an agent that
  // searches the index (office-format-upgrade.ts); for any other agent, only a
  // reindex converts these files.
  it("says Pinchy converts them on its own for an agent that searches the index", async () => {
    serve(summary({ awaiting: 1, searchesIndex: true }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() =>
      expect(screen.getByText(/Pinchy converts it again on its own/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/a reindex converts/i)).not.toBeInTheDocument();
  });

  it("says a reindex converts them for an agent that doesn't search the index", async () => {
    serve(summary({ awaiting: 1, searchesIndex: false }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/a reindex converts it/i)).toBeInTheDocument());
    expect(screen.queryByText(/on its own/i)).not.toBeInTheDocument();
  });

  it("says nothing about conversion when no document is waiting for one", async () => {
    serve(summary({ noText: 1 }));

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);

    await waitFor(() => expect(screen.getByText(/no searchable text/i)).toBeInTheDocument());
    expect(screen.queryByText(/converted again/i)).not.toBeInTheDocument();
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

  // A folder that fails to load must say so, not read as an empty folder.
  it("says when a folder's documents couldn't be loaded", async () => {
    serve(summary({ noText: 1 }));
    const user = userEvent.setup();

    render(<KnowledgeUnsearchableList agentId="a1" announceNone />);
    await user.click(await screen.findByRole("button", { name: /show the document/i }));

    expect(await screen.findByText(/couldn't load these documents/i)).toBeInTheDocument();
  });
});
