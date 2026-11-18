// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { edgeFadeMask, useScrollEdgeFade } from "@/hooks/use-scroll-edge-fade";

// #1400: a horizontally scrolling row with a hidden scrollbar gives no hint
// that more items sit off-screen. The fade marks each edge that still has
// content beyond it — and only those, so a row that fits is left untouched.

describe("edgeFadeMask", () => {
  it("is absent when the content fits", () => {
    expect(edgeFadeMask({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBeUndefined();
  });

  it("fades only the right edge at the start", () => {
    const mask = edgeFadeMask({ scrollLeft: 0, clientWidth: 300, scrollWidth: 700 });
    expect(mask).toBe("linear-gradient(to right, black 0, black calc(100% - 2rem), transparent)");
  });

  it("fades only the left edge at the end", () => {
    const mask = edgeFadeMask({ scrollLeft: 400, clientWidth: 300, scrollWidth: 700 });
    expect(mask).toBe("linear-gradient(to right, transparent, black 2rem, black 100%)");
  });

  it("fades both edges in the middle", () => {
    const mask = edgeFadeMask({ scrollLeft: 100, clientWidth: 300, scrollWidth: 700 });
    expect(mask).toBe(
      "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)"
    );
  });

  it("tolerates sub-pixel scroll positions at the end", () => {
    // Zoomed or high-DPI browsers report fractional scrollLeft.
    expect(edgeFadeMask({ scrollLeft: 399.5, clientWidth: 300, scrollWidth: 700 })).toBe(
      "linear-gradient(to right, transparent, black 2rem, black 100%)"
    );
  });
});

function Row() {
  const { ref, style } = useScrollEdgeFade<HTMLDivElement>();
  return <div data-testid="row" ref={ref} style={style} />;
}

describe("useScrollEdgeFade", () => {
  it("updates the mask when the row scrolls", () => {
    render(<Row />);
    const row = screen.getByTestId("row");
    expect(row.style.maskImage).toBe("");

    Object.defineProperty(row, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 700 });
    row.scrollLeft = 400;
    fireEvent.scroll(row);

    expect(row.style.maskImage).toBe(
      "linear-gradient(to right, transparent, black 2rem, black 100%)"
    );
  });
});
