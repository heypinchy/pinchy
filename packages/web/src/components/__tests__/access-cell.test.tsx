// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessCell } from "@/components/access-cell";

describe("AccessCell", () => {
  it("exposes exactly one selected state", () => {
    render(<AccessCell value="ask" onChange={() => {}} label="delete account.move" />);
    const checked = screen.getAllByRole("radio", { checked: true });
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAccessibleName(/ask first/i);
  });

  // The reason this is a radiogroup and not a tri-state checkbox: `mixed` is
  // standardised as "partially checked" and reads as system-set, so reusing it
  // for "needs approval" would break a convention on a security setting.
  it("is a radiogroup, not a mixed checkbox", () => {
    render(<AccessCell value="off" onChange={() => {}} label="delete account.move" />);
    expect(screen.getByRole("radiogroup")).toHaveAccessibleName("delete account.move");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("reports the state the user picked", async () => {
    const onChange = vi.fn();
    render(<AccessCell value="allow" onChange={onChange} label="write res.partner" />);
    await userEvent.click(screen.getByRole("radio", { name: /ask first/i }));
    expect(onChange).toHaveBeenCalledWith("ask");
  });

  it("moves between states with the arrow keys", async () => {
    const onChange = vi.fn();
    render(<AccessCell value="off" onChange={onChange} label="read note.note" />);
    screen.getByRole("radio", { checked: true }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("ask");
  });

  it("does not fire when disabled", async () => {
    const onChange = vi.fn();
    render(<AccessCell value="off" onChange={onChange} label="read note.note" disabled />);
    await userEvent.click(screen.getByRole("radio", { name: /allowed —/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
