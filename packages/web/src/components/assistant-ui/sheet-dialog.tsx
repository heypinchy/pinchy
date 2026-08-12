"use client";

import { useEffect, useState, type FC, type ReactNode } from "react";
import { Sheet as SheetIcon } from "lucide-react";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { SheetRange } from "@/lib/knowledge/xlsx-extract";

/**
 * What a cited spreadsheet opens into: the rows the citation names, as a table.
 *
 * Deliberately NOT the PDF lightbox. A spreadsheet has no page to open at, and
 * converting one to a PDF would clip exactly the wide columns the cell-based
 * ingest exists to preserve (see xlsx-extract.ts) — so the thing to put in
 * front of a reader is the cells themselves, which is also what the index read.
 *
 * The rows are fetched when the dialog OPENS rather than with the message. A
 * long answer can cite a dozen documents, and reading a dozen workbooks to
 * render text nobody has clicked would charge every answer for a pane most
 * readers never see.
 */
export const SheetDialog: FC<{
  /** The citation href; the rows request is derived from it. */
  url: string;
  title: string;
  /**
   * The cited anchor — all three together, or none of them: a bare workbook
   * mention names no sheet, and the dialog then asks for the top of the
   * workbook (the route resolves that to the first visible sheet).
   */
  sheet?: string;
  startRow?: number;
  endRow?: number;
  children: ReactNode;
  /** Test-only escape hatch; the dialog is trigger-driven in the app. */
  defaultOpen?: boolean;
}> = ({ url, title, sheet, startRow, endRow, children, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [range, setRange] = useState<SheetRange | null>(null);
  const [error, setError] = useState(false);
  const filename = title.split("/").filter(Boolean).pop() ?? title;
  const hasRange = sheet !== undefined && startRow !== undefined && endRow !== undefined;

  useEffect(() => {
    if (!open || range || error) return;
    const base = url.split("#")[0];
    const query = hasRange
      ? `&variant=rows&sheet=${encodeURIComponent(sheet)}&from=${startRow}&to=${endRow}`
      : "&variant=rows";
    let cancelled = false;

    void fetch(`${base}${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: SheetRange) => {
        if (!cancelled) setRange(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, range, error, url, hasRange, sheet, startRow, endRow]);

  const rangeLabel = startRow === endRow ? `row ${startRow}` : `rows ${startRow}-${endRow}`;
  // What the resolved range is called once loaded: the citation's own anchor
  // when it named one, otherwise the sheet the route resolved the bare mention
  // to — so the reader still learns which sheet they are looking at.
  const anchorLabel = hasRange ? `${sheet}, ${rangeLabel}` : (range?.sheet ?? null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
          <SheetIcon className="size-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="truncate font-medium text-sm" title={title}>
            {filename}
          </DialogTitle>
          {/* The anchor the reader is looking at, spelled the way the citation
              spelled it, so the two are recognisably the same thing. */}
          {anchorLabel && (
            <span className="shrink-0 text-muted-foreground text-xs">{anchorLabel}</span>
          )}
          <Button asChild size="sm" variant="ghost" className="ml-auto shrink-0">
            {/* The workbook itself. A preview answers "does the answer say what
                this document says"; the file answers everything else. */}
            <a href={`${url.split("#")[0]}&download=1&variant=original`}>Download</a>
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {error ? (
            <p className="text-muted-foreground text-sm">
              This workbook could not be read. The file is still available to download.
            </p>
          ) : !range ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : range.rows.length === 0 ? (
            // An honest empty state rather than a blank pane: the citation
            // resolved to a document but not to rows inside it.
            <p className="text-muted-foreground text-sm">
              {hasRange
                ? `This document has no “${sheet}” rows in that range.`
                : "This workbook has no rows to show."}
            </p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2 font-medium text-muted-foreground">#</th>
                  {/* Keyed by INDEX on purpose: two columns legitimately share
                      one header label, and cells align to columns by position
                      (the server guarantees the alignment — see SheetRange). */}
                  {range.columns.map((column, index) => (
                    <th key={index} className="p-2 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {range.rows.map((row) => (
                  <tr key={row.number} className="border-b last:border-0">
                    {/* The sheet's own row number, so a reader can find the row
                        again in Excel rather than counting from the top. */}
                    <td className="p-2 text-muted-foreground tabular-nums">{row.number}</td>
                    {range.columns.map((_, index) => (
                      <td key={index} className="p-2 align-top">
                        {row.cells[index] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
