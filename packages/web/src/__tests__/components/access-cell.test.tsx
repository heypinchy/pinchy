// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccessCell } from "@/components/access-cell";

/**
 * The selected "Not allowed" segment must stand out from the unselected ones
 * by more than a near-white fill. Unselected icons use the full muted colour
 * (faded muted text is banned for contrast, #1300), so if the selected `off`
 * segment used it too, the only difference left would be bg-muted on white
 * (~1.1:1) — invisible in a matrix where most cells are `off` (WCAG 1.4.11).
 */
describe("AccessCell", () => {
  it("marks the selected 'Not allowed' segment with a darker icon and a visible outline", () => {
    render(<AccessCell value="off" onChange={() => {}} label="delete account.move" />);
    const selected = screen.getByRole("radio", { name: "Not allowed" });
    const unselected = screen.getByRole("radio", { name: /Allowed — the agent/ });

    expect(selected).toHaveAttribute("aria-checked", "true");
    // The outline is muted-foreground (≥5.5:1 on the muted fill in both
    // themes): a border-coloured ring is ~1.15:1 and invisible in dark mode.
    // An inset-ring, not ring-inset, so the focus ring stays outset.
    expect(selected).toHaveClass("text-foreground", "inset-ring", "inset-ring-muted-foreground");
    expect(selected).not.toHaveClass("ring-inset");
    expect(unselected).toHaveClass("text-muted-foreground");
    expect(unselected).not.toHaveClass("inset-ring");
  });
});
