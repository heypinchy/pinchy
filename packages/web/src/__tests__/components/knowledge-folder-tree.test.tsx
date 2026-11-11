// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { KnowledgeFolderTree, countText } from "@/components/knowledge-folder-tree";
import { apiGet } from "@/lib/api-client";
import type {
  FolderFilesResult,
  FolderStatus,
  FolderStatusResult,
} from "@/lib/knowledge/index-status";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});

const mockGet = vi.mocked(apiGet);

function folder(overrides: Partial<FolderStatus> & { path: string }): FolderStatus {
  return {
    name: overrides.path.split("/").pop() ?? overrides.path,
    state: "searchable",
    indexed: 0,
    searchable: 0,
    notSearchable: 0,
    expected: null,
    pending: 0,
    pendingArchived: 0,
    expectedArchived: 0,
    archivedToReconvert: 0,
    indexingArchive: false,
    lastIndexedAt: null,
    ...overrides,
  };
}

const status: FolderStatusResult = {
  job: {
    status: "running",
    processed: 12,
    total: 60,
    currentFolder: "/data/kb/certs",
    finishedAt: null,
  },
  folders: [
    {
      ...folder({
        path: "/data/kb",
        name: "/data/kb",
        state: "indexing",
        expected: 60,
        pending: 48,
      }),
      children: [
        folder({ path: "/data/kb/certs", state: "indexing", expected: 30, pending: 18 }),
        folder({ path: "/data/kb/legal", state: "queued", expected: 20, pending: 20 }),
        folder({
          path: "/data/kb/hr",
          state: "has_errors",
          indexed: 10,
          searchable: 8,
          notSearchable: 2,
          expected: 10,
          lastIndexedAt: "2026-11-01T10:00:00.000Z",
        }),
        folder({
          path: "/data/kb/old",
          state: "searchable",
          indexed: 5,
          searchable: 5,
          expected: 5,
        }),
      ],
    },
  ],
};

function files(overrides: Partial<FolderFilesResult> = {}): FolderFilesResult {
  return {
    folder: "/data/kb/hr",
    files: [
      {
        path: "/data/kb/hr/policy.pdf",
        name: "policy.pdf",
        state: "searchable",
        archived: false,
        indexedAt: null,
        modifiedAt: null,
      },
      {
        path: "/data/kb/hr/scan.pdf",
        name: "scan.pdf",
        state: "no_text",
        archived: false,
        indexedAt: null,
        modifiedAt: null,
      },
    ],
    total: 2,
    totals: { all: 2, searchable: 1, notSearchable: 1, unsupported: 0, ignored: 0 },
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KnowledgeFolderTree", () => {
  it("shows every state the children are in once the root is opened", async () => {
    mockGet.mockResolvedValue(status);
    render(<KnowledgeFolderTree agentId="a1" />);

    await userEvent.click(
      await screen.findByRole("button", { name: /show subfolders of \/data\/kb/i })
    );

    const list = screen.getByRole("list", { name: /folders this agent searches/i });
    expect(within(list).getAllByText("Indexing now")).toHaveLength(2);
    expect(within(list).getByText("Queued")).toBeInTheDocument();
    expect(within(list).getByText("Needs attention")).toBeInTheDocument();
    expect(within(list).getByText("Searchable")).toBeInTheDocument();
    expect(within(list).getByText("12 of 30 files done")).toBeInTheDocument();
    expect(within(list).getByText("8 of 10 files searchable")).toBeInTheDocument();
  });

  // jsdom cannot measure, so this pins the layout contract behind #1401: the
  // name's box starts at its own text width (a basis of 0 left it only the
  // space the metadata did not take, one pixel short of "kalkulation"), and
  // the row may wrap, so the metadata moves below the name before the name
  // is cut. A name too long for a line of its own still truncates.
  it("gives the folder name priority over the metadata beside it", async () => {
    mockGet.mockResolvedValue(status);
    render(<KnowledgeFolderTree agentId="a1" />);

    const name = await screen.findByTitle("/data/kb");
    expect(name).toHaveClass("truncate");

    const nameBox = name.parentElement!;
    expect(nameBox).not.toHaveClass("flex-1");
    expect(nameBox).toHaveClass("grow", "min-w-0", "max-w-full");

    const row = nameBox.parentElement!;
    expect(row).toHaveClass("sm:flex-row", "sm:flex-wrap");
  });

  it("asks the folders route of the agent it was given", async () => {
    mockGet.mockResolvedValue({ job: null, folders: [] });
    render(<KnowledgeFolderTree agentId="agent-7" />);

    expect(await screen.findByText(/no folders to search yet/i)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/api/agents/agent-7/knowledge/folders");
  });

  it("offers a retry when the first read fails", async () => {
    mockGet.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(status);
    render(<KnowledgeFolderTree agentId="a1" />);

    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));

    expect(await screen.findByText("/data/kb")).toBeInTheDocument();
  });

  it("re-reads while a run is in flight, and stops once it is over", async () => {
    const finished: FolderStatusResult = {
      ...status,
      job: { ...status.job!, status: "succeeded" },
    };
    mockGet.mockResolvedValueOnce(status).mockResolvedValue(finished);
    render(<KnowledgeFolderTree agentId="a1" pollIntervalMs={20} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    const calls = mockGet.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(mockGet.mock.calls.length).toBe(calls);
  });

  it("lists a folder's files with their state, and filters to the ones not yet searchable", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders") ? status : files()
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));

    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));

    expect(await screen.findByText("scan.pdf")).toBeInTheDocument();
    expect(screen.getByText("No searchable text")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 files searchable/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Not yet searchable" }));

    await waitFor(() =>
      expect(mockGet).toHaveBeenLastCalledWith(expect.stringContaining("filter=not_searchable"))
    );
    const last = new URL(mockGet.mock.lastCall![0], "http://x");
    expect(last.pathname).toBe("/api/agents/a1/knowledge/files");
    expect(last.searchParams.get("folder")).toBe("/data/kb/hr");
  });

  it("searches by name", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders") ? status : files()
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));
    await screen.findByText("scan.pdf");

    await userEvent.type(screen.getByLabelText(/search files by name/i), "scan");

    await waitFor(() =>
      expect(new URL(mockGet.mock.lastCall![0], "http://x").searchParams.get("q")).toBe("scan")
    );
  });

  it("loads the next page on request and keeps the first", async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes("/folders")) return status;
      const offset = new URL(url, "http://x").searchParams.get("offset");
      return offset === "0"
        ? files({ total: 3 })
        : files({
            total: 3,
            files: [
              {
                path: "/data/kb/hr/z.pdf",
                name: "z.pdf",
                state: "failed",
                archived: false,
                indexedAt: null,
                modifiedAt: null,
              },
            ],
          });
    });
    render(<KnowledgeFolderTree agentId="a1" pageSize={2} />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));
    expect(await screen.findByText("Showing 2 of 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(await screen.findByText("z.pdf")).toBeInTheDocument();
    expect(screen.getByText("policy.pdf")).toBeInTheDocument();
    expect(screen.getByText("Not indexed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  // A subfolder row counts its whole subtree, even when it is also a granted
  // root; the root row counts only its own files. Each list must match its row.
  it("asks for a subfolder's whole subtree and a root's own files", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders") ? status : files()
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));

    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));
    await screen.findByText("scan.pdf");
    expect(new URL(mockGet.mock.lastCall![0], "http://x").searchParams.get("scope")).toBe("tree");

    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb" }));
    await waitFor(() =>
      expect(new URL(mockGet.mock.lastCall![0], "http://x").searchParams.get("folder")).toBe(
        "/data/kb"
      )
    );
    expect(new URL(mockGet.mock.lastCall![0], "http://x").searchParams.get("scope")).toBe("direct");
  });

  it("says a root's list holds only its own files, and points to the subfolders", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders")
        ? status
        : files({
            files: [],
            total: 0,
            totals: { all: 0, searchable: 0, notSearchable: 0, unsupported: 0, ignored: 0 },
          })
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Show files in /data/kb" }));

    expect(
      await screen.findByText(
        "No files directly in this folder. Open a subfolder to see its files."
      )
    ).toBeInTheDocument();
  });

  it("counts the files the index cannot read apart from the rest", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders")
        ? status
        : files({
            totals: { all: 2, searchable: 1, notSearchable: 1, unsupported: 3, ignored: 0 },
          })
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));

    expect(
      await screen.findByText(/1 of 2 files searchable, plus 3 files the index can't read yet\./)
    ).toBeInTheDocument();
  });

  // #1410: a driver or a data export is not a document anybody has to convert.
  // It is still named — skipped, not hidden — but apart from the documents.
  it("names files that are not documents apart from the ones the index can't read yet", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders")
        ? status
        : files({
            totals: { all: 2, searchable: 1, notSearchable: 1, unsupported: 3, ignored: 4 },
          })
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));

    expect(
      await screen.findByText(
        /1 of 2 files searchable, plus 3 files the index can't read yet and 4 files skipped because they aren't documents\./
      )
    ).toBeInTheDocument();
  });

  it("marks a file that is not a document as skipped, without asking for attention", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders")
        ? status
        : files({
            files: [
              {
                path: "/data/kb/hr/driver.dll",
                name: "driver.dll",
                state: "ignored",
                archived: false,
                indexedAt: null,
                modifiedAt: null,
              },
            ],
            total: 1,
            totals: { all: 0, searchable: 0, notSearchable: 0, unsupported: 0, ignored: 1 },
          })
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));

    const label = await screen.findByText("Not a document — skipped");
    expect(label.className).not.toMatch(/amber/);
  });

  it("says when a folder is too large to list in full", async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/folders") ? status : files({ truncated: true })
    );
    render(<KnowledgeFolderTree agentId="a1" />);
    await userEvent.click(await screen.findByRole("button", { name: /show subfolders/i }));
    await userEvent.click(screen.getByRole("button", { name: "Show files in /data/kb/hr" }));

    expect(await screen.findByText(/too large to list in full/)).toBeInTheDocument();
  });
});

describe("countText", () => {
  it("counts against what the run found, not only against what made it in", () => {
    expect(
      countText(
        folder({ path: "/a", state: "has_errors", indexed: 40, searchable: 40, expected: 100 })
      )
    ).toBe("40 of 100 files searchable");
  });

  it("is honest before a run has listed its files", () => {
    expect(countText(folder({ path: "/a", state: "queued", expected: null }))).toBe(
      "Waiting for the run to list its files"
    );
  });

  // A new run that has not listed its files yet still carries the last run's
  // expected count, with nothing pending: that is not "all done".
  it("does not call a queued folder done before the run has listed its files", () => {
    expect(countText(folder({ path: "/a", state: "queued", expected: 40, pending: 0 }))).toBe(
      "Waiting for the run to list its files"
    );
  });

  it("names an empty folder and a folder nothing has looked at", () => {
    expect(countText(folder({ path: "/a", state: "empty", expected: 0 }))).toBe(
      "Nothing to index here"
    );
    expect(countText(folder({ path: "/a", state: "not_indexed" }))).toBe("No files indexed yet");
  });

  // #1405: a run reads archived subfolders last. A folder whose current files
  // are all in is searchable, and its archive still to come is counted apart
  // instead of holding the whole row at "677 of 1105 files done".
  it("counts the archive still to come apart from the current files", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "searchable",
          indexed: 677,
          searchable: 677,
          expected: 1105,
          pending: 428,
          pendingArchived: 428,
          expectedArchived: 428,
        })
      )
    ).toBe("677 of 677 files searchable · 428 archived files queued");
  });

  it("says when the run is reading the folder's archive", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "searchable",
          indexed: 680,
          searchable: 680,
          expected: 1105,
          pending: 425,
          pendingArchived: 425,
          expectedArchived: 428,
          indexingArchive: true,
        })
      )
    ).toBe("680 of 680 files searchable · indexing archived files, 425 left");
  });

  // A later run re-reads an archive the index already holds: never "1105 of 677".
  it("does not count more searchable files than the folder holds on a re-run", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "searchable",
          indexed: 1105,
          searchable: 1105,
          expected: 1105,
          pending: 428,
          pendingArchived: 428,
          expectedArchived: 428,
        })
      )
    ).toBe("1105 of 1105 files searchable · 428 archived files queued");
  });

  // Documents of files deleted since the last run stay in the index until the
  // run ends, so the index can hold more than the run found: never "1105 of 1102".
  it("does not count documents of files the run no longer found", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "searchable",
          indexed: 1105,
          searchable: 1105,
          expected: 1102,
          pending: 427,
          pendingArchived: 427,
          expectedArchived: 427,
        })
      )
    ).toBe("1102 of 1102 files searchable · 427 archived files queued");
    expect(
      countText(
        folder({ path: "/a", state: "searchable", indexed: 42, searchable: 42, expected: 40 })
      )
    ).toBe("40 of 40 files searchable");
  });

  // A failed run removes nothing, so documents of deleted files outlive it.
  // They must not make up for the files that hold no text.
  it("never counts a folder that needs attention as fully searchable", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "has_errors",
          indexed: 45,
          searchable: 42,
          notSearchable: 3,
          expected: 40,
        })
      )
    ).toBe("37 of 40 files searchable");
  });

  it("counts archived files the run will convert again as on their way", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "searchable",
          indexed: 45,
          searchable: 40,
          notSearchable: 5,
          archivedToReconvert: 5,
          expected: 45,
          pending: 5,
          pendingArchived: 5,
          expectedArchived: 5,
        })
      )
    ).toBe("40 of 40 files searchable · 5 archived files queued");
  });

  // While a folder's current files are still being read, count against them:
  // the archive comes last and is counted apart, so the row doesn't sit at
  // "677 of 1105 files done" long after the last current file is in.
  it("counts a folder's current files apart from its archive while they are read", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "indexing",
          expected: 1105,
          expectedArchived: 428,
          pending: 430,
          pendingArchived: 428,
        })
      )
    ).toBe("675 of 677 files done · 428 archived files queued");
  });

  it("counts a folder of only archived files as archived files", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "indexing",
          expected: 5,
          expectedArchived: 5,
          pending: 4,
          pendingArchived: 4,
        })
      )
    ).toBe("1 of 5 archived files done");
    expect(
      countText(
        folder({
          path: "/a",
          state: "queued",
          expected: 5,
          expectedArchived: 5,
          pending: 5,
          pendingArchived: 5,
        })
      )
    ).toBe("0 of 5 archived files done");
  });

  it("names the archive in the singular", () => {
    expect(
      countText(
        folder({
          path: "/a",
          state: "has_errors",
          indexed: 3,
          searchable: 2,
          expected: 4,
          pending: 1,
          pendingArchived: 1,
          expectedArchived: 1,
        })
      )
    ).toBe("2 of 3 files searchable · 1 archived file queued");
  });

  it("uses the singular for one file", () => {
    expect(countText(folder({ path: "/a", indexed: 1, searchable: 1, expected: 1 }))).toBe(
      "1 of 1 file searchable"
    );
  });
});
