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
  sheet: string;
  startRow: number;
  endRow: number;
  children: ReactNode;
  /** Test-only escape hatch; the dialog is trigger-driven in the app. */
  defaultOpen?: boolean;
}> = ({ url, title, sheet, startRow, endRow, children, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [range, setRange] = useState<SheetRange | null>(null);
  const [error, setError] = useState(false);
  const filename = title.split("/").filter(Boolean).pop() ?? title;

  useEffect(() => {
    if (!open || range || error) return;
    const base = url.split("#")[0];
    const query = `&variant=rows&sheet=${encodeURIComponent(sheet)}&from=${startRow}&to=${endRow}`;
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
  }, [open, range, error, url, sheet, startRow, endRow]);

  const rangeLabel = startRow === endRow ? `row ${startRow}` : `rows ${startRow}-${endRow}`;

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
          <span className="shrink-0 text-muted-foreground text-xs">
            {sheet}, {rangeLabel}
          </span>
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
              This document has no {sheet ? `“${sheet}” ` : ""}rows in that range.
            </p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2 font-medium text-muted-foreground">#</th>
                  {range.columns.map((column) => (
                    <th key={column} className="p-2 font-medium">
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
                    {range.columns.map((column) => (
                      <td key={column} className="p-2 align-top">
                        {row.cells.find((cell) => cell.label === column)?.text ?? ""}
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
