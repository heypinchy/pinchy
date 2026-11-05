// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";

/**
 * A table wider than its container scrolls horizontally, and a keyboard user
 * can only scroll a region that can take focus (axe
 * `scrollable-region-focusable`, #1300 — the Usage table on a phone). A table
 * that fits must NOT add a tab stop: an empty stop on every table is noise.
 */
function stubWidths(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  });
}

afterEach(() => {
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

function renderTable() {
  const { container } = render(
    <Table aria-label="Usage by agent">
      <TableBody>
        <TableRow>
          <TableCell>Smithers</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
  return container.querySelector('[data-slot="table-container"]') as HTMLElement;
}

describe("Table scroll container (#1300)", () => {
  it("is keyboard-focusable when the table overflows", () => {
    stubWidths(800, 340);
    const region = renderTable();
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("ignores a 1px rounding overshoot, which is not a scroll", () => {
    stubWidths(341, 340);
    expect(renderTable()).not.toHaveAttribute("tabindex");
  });

  it("is focusable from a 2px overflow on", () => {
    stubWidths(342, 340);
    expect(renderTable()).toHaveAttribute("tabindex", "0");
  });

  it("adds no tab stop when the table fits", () => {
    stubWidths(300, 340);
    const region = renderTable();
    expect(region).not.toHaveAttribute("tabindex");
  });
});
