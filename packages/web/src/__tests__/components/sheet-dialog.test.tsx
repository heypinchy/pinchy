// @vitest-environment jsdom
/**
 * The pane a cited spreadsheet opens into.
 *
 * What is worth asserting here is not the markup but the four states a reader
 * can actually land in — the rows, an empty range, a workbook that will not
 * open, and a reader that is busy — plus the performance properties that are
 * product decisions rather than implementation details: nothing is fetched
 * until the dialog opens, and nothing stays fetched once it is closed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SheetDialog } from "@/components/assistant-ui/sheet-dialog";

const HREF = "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fx%2Fpreise.xlsx";

const RANGE = {
  sheet: "Suppliers",
  columns: ["Supplier", "Price"],
  // Cells arrive index-aligned to `columns` — the SERVER aligns them (see
  // readSheetRange), so a sparse row carries "" where it has no cell and the
  // dialog renders positionally without any matching logic of its own.
  rows: [
    { number: 3, cells: ["Acme", "20"] },
    { number: 4, cells: ["Globex", ""] },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, ok = true, status = ok ? 200 : 422) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body, status });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const open = (props: Partial<Parameters<typeof SheetDialog>[0]> = {}) =>
  render(
    <SheetDialog
      url={HREF}
      title="lieferanten/preise.xlsx"
      sheet="Suppliers"
      startRow={3}
      endRow={4}
      defaultOpen
      {...props}
    >
      <button type="button">open</button>
    </SheetDialog>
  );

describe("SheetDialog", () => {
  it("shows the cited rows with their sheet row numbers", async () => {
    mockFetch(RANGE);
    open();

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
    // The sheet's own numbering, so a reader can find the row again in Excel
    // rather than counting from the top of the preview.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("asks for exactly the range the citation named", async () => {
    const fetchMock = mockFetch(RANGE);
    open();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("variant=rows");
    expect(url).toContain("sheet=Suppliers");
    expect(url).toContain("from=3");
    expect(url).toContain("to=4");
  });

  it("asks for the top of the workbook when the citation named no rows", async () => {
    // A bare workbook mention carries no sheet and no range. The dialog then
    // requests variant=rows with no range parameters, which the route answers
    // with the first visible sheet from the top.
    const fetchMock = mockFetch(RANGE);
    open({ sheet: undefined, startRow: undefined, endRow: undefined });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("variant=rows");
    expect(url).not.toContain("sheet=");
    expect(url).not.toContain("from=");
    expect(url).not.toContain("to=");
  });

  it("fetches nothing until it is opened", async () => {
    // A long answer can cite a dozen documents. Reading a dozen workbooks to
    // render panes nobody clicked would charge every answer for the feature.
    const fetchMock = mockFetch(RANGE);
    open({ defaultOpen: false });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so plainly when the range holds no rows", async () => {
    // The citation resolved to a document but not to rows inside it. A blank
    // pane would read as a broken viewer.
    mockFetch({ sheet: "Suppliers", columns: [], rows: [] });
    open();

    expect(await screen.findByText(/no .*rows in that range/i)).toBeInTheDocument();
  });

  it("keeps the download reachable when the workbook cannot be read", async () => {
    // The one state where the preview has nothing to offer: the file itself is
    // still the answer, so the control that hands it over must survive.
    mockFetch({ error: "nope" }, false);
    open();

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      expect.stringContaining("variant=original")
    );
  });

  // A 503 is the READER being busy or unavailable,
  // never a fact about the workbook — and a preview nobody is looking at any
  // more must not keep a read queued on the server.
  it("says the reader is busy, not that the workbook is broken, on a 503", async () => {
    mockFetch({ error: "busy" }, false, 503);
    open();

    expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });

  it("asks again when it is reopened after the reader was busy", async () => {
    const fetchMock = mockFetch({ error: "busy" }, false, 503);
    render(
      <SheetDialog url={HREF} title="preise.xlsx" sheet="Suppliers" startRow={3} endRow={4}>
        <button type="button">open</button>
      </SheetDialog>
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument();

    fetchMock.mockResolvedValue({ ok: true, json: async () => RANGE, status: 200 });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/try again/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels its request when it is closed before the rows arrive", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }) as unknown as typeof fetch;
    const { unmount } = open();

    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
