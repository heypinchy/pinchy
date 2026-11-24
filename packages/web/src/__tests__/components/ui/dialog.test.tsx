// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

// jsdom does no layout, so "a tall dialog scrolls on a short window" cannot be
// measured here. What can be pinned is the contract that produces it: the
// shared DialogContent is vertically centred with translate-y-[-50%], so
// without a height cap a dialog taller than the viewport spills off BOTH edges
// and the clipped part is unreachable (#906). Every dialog in the app inherits
// these two classes, which is why they are worth a guard.

function renderContent(className?: string) {
  render(
    <Dialog open>
      <DialogContent className={className} aria-describedby={undefined}>
        <DialogTitle>Title</DialogTitle>
      </DialogContent>
    </Dialog>
  );
  return screen.getByRole("dialog");
}

describe("DialogContent", () => {
  it("caps its height to the viewport and scrolls internally (#906)", () => {
    const content = renderContent();
    expect(content).toHaveClass("max-h-[calc(100dvh-2rem)]");
    expect(content).toHaveClass("overflow-y-auto");
  });

  it("lets a caller's own height and overflow replace the defaults, not stack on them", () => {
    // The file and sheet viewers manage their own scroll region and set
    // overflow-hidden; a leftover overflow-y-auto would give them a second
    // scrollbar around the one they already have.
    const content = renderContent("flex h-[92dvh] flex-col overflow-hidden max-h-[85dvh]");
    expect(content).toHaveClass("overflow-hidden", "max-h-[85dvh]");
    expect(content).not.toHaveClass("overflow-y-auto");
    expect(content).not.toHaveClass("max-h-[calc(100dvh-2rem)]");
  });
});
