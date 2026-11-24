// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CopyField } from "@/components/copy-field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const URL_VALUE = "https://pinchy.example.com/invite/abc123";

function setShare(share: unknown) {
  Object.defineProperty(navigator, "share", {
    value: share,
    writable: true,
    configurable: true,
  });
}

function removeShare() {
  // @ts-expect-error removing the Web Share API for the "absent" branch
  delete navigator.share;
}

describe("CopyField", () => {
  afterEach(() => {
    removeShare();
    // @ts-expect-error removing the stub the clipboard-refusal test installs
    delete document.execCommand;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the whole value, labelled, with Copy as the primary action", () => {
    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);

    const group = screen.getByRole("group", { name: "Invite link" });
    expect(group).toHaveTextContent(URL_VALUE);
    const copy = screen.getByRole("button", { name: "Copy link" });
    // The primary button style, not the outline one Share uses.
    expect(copy).toHaveAttribute("data-variant", "default");
  });

  it("takes its name from a visible label when one is given, so it isn't read twice", () => {
    render(
      <>
        <p id="reset-link-label">Reset link:</p>
        <CopyField
          value={URL_VALUE}
          label="Reset link"
          labelledBy="reset-link-label"
          copyLabel="Copy link"
        />
      </>
    );

    const group = screen.getByRole("group", { name: "Reset link:" });
    expect(group).not.toHaveAttribute("aria-label");
  });

  it("puts focus on Copy when asked, so a screen reader hears the new link arrive", () => {
    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" autoFocus />);

    expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
  });

  it("stacks by its own width, not the viewport's, so a narrow sheet keeps the value readable", () => {
    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);

    const group = screen.getByRole("group", { name: "Invite link" });
    // A container query: inside a 384px sheet on a wide screen, the buttons
    // go below the value instead of squeezing it into a sliver beside them.
    expect(group.className).toContain("@container");
    expect(group.innerHTML).not.toMatch(/\bsm:flex-row\b/);
  });

  it("copies the value, confirms on the button and announces it to screen readers", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(writeText).toHaveBeenCalledWith(URL_VALUE);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Invite link copied.");
  });

  it("goes back to the copy label after about two seconds and clears the announcement", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });

    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("selects the value and says how to copy it by hand when the browser refuses", async () => {
    const user = userEvent.setup();
    // Both routes fail: the async Clipboard API rejects (plain-HTTP intranet
    // install, missing permission) and the legacy execCommand returns false.
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    // jsdom has no execCommand of its own; afterEach deletes this one again so
    // the refusal doesn't leak into later tests.
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      writable: true,
      configurable: true,
    });

    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't copy automatically. It's selected — press Ctrl+C (⌘C on a Mac)."
      );
    });
    expect(window.getSelection()?.toString()).toBe(URL_VALUE);
    // No false "Copied" confirmation.
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
  });

  it("copies through the fallback from inside a dialog, whose focus trap would otherwise undo it", async () => {
    // Plain-HTTP intranet install: no async Clipboard API, so the hook copies
    // from a hidden textarea via execCommand. That only works while the
    // textarea holds focus. Four of the five places using CopyField sit in a
    // Radix dialog, whose focus trap pulls focus back the moment it lands
    // outside the dialog — so a textarea appended to <body> loses it before
    // the copy runs, execCommand copies nothing, and the button still says
    // "Copied".
    const user = userEvent.setup();
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    let copiedText: string | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const active = document.activeElement;
        copiedText = active instanceof HTMLTextAreaElement ? active.value : null;
        return true;
      }),
      writable: true,
      configurable: true,
    });

    try {
      render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Invite User</DialogTitle>
            <CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />
          </DialogContent>
        </Dialog>
      );

      await user.click(screen.getByRole("button", { name: "Copy link" }));

      expect(copiedText).toBe(URL_VALUE);
      // Focus goes back to where the person was, not to <body>.
      expect(screen.getByRole("button", { name: "Copied" })).toHaveFocus();
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    }
  });

  it("copies through the fallback in a dialog even when the click doesn't focus the button (Safari, Firefox on macOS)", () => {
    // Safari and Firefox on macOS don't focus a button on mouse click; focus
    // stays on the dialog container, which Radix portals straight into
    // <body>. So the textarea can't be placed by where focus is — it goes
    // inside the field itself.
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    let copiedText: string | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const active = document.activeElement;
        copiedText = active instanceof HTMLTextAreaElement ? active.value : null;
        return true;
      }),
      writable: true,
      configurable: true,
    });

    try {
      render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Invite User</DialogTitle>
            <CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />
          </DialogContent>
        </Dialog>
      );

      const dialog = screen.getByRole("dialog");
      dialog.focus();
      expect(dialog).toHaveFocus();
      // fireEvent.click dispatches the click without moving focus — what a
      // mouse click on a button does in those browsers.
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

      expect(copiedText).toBe(URL_VALUE);
      expect(dialog).toHaveFocus();
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    }
  });

  it("offers Share as a secondary action where the Web Share API exists", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);

    render(
      <CopyField
        value={URL_VALUE}
        label="Invite link"
        copyLabel="Copy link"
        share={{ title: "Pinchy invite" }}
      />
    );

    const shareButton = await screen.findByRole("button", { name: "Share" });
    expect(shareButton).toHaveAttribute("data-variant", "outline");
    // Copy stays available next to it — Share is an addition, not a replacement.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();

    await user.click(shareButton);
    expect(share).toHaveBeenCalledWith({ title: "Pinchy invite", url: URL_VALUE });
  });

  it("hides Share where the Web Share API is missing", () => {
    removeShare();

    render(
      <CopyField
        value={URL_VALUE}
        label="Invite link"
        copyLabel="Copy link"
        share={{ title: "Pinchy invite" }}
      />
    );

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("never offers Share for a value that isn't meant to be shared (secrets)", () => {
    setShare(vi.fn());

    render(<CopyField value="pinchy_secret" label="API key" copyLabel="Copy key" />);

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  it("stays quiet when the person cancels the share sheet", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    setShare(share);

    render(
      <CopyField
        value={URL_VALUE}
        label="Invite link"
        copyLabel="Copy link"
        share={{ title: "Pinchy invite" }}
      />
    );

    await user.click(await screen.findByRole("button", { name: "Share" }));

    expect(share).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("starts fresh when it is handed a new value", async () => {
    // Resend and Reset Password replace the link in the same panel. A failed
    // copy of the old link must not leave "It's selected — press Ctrl+C"
    // standing under the new one, which nothing has selected.
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      writable: true,
      configurable: true,
    });

    const { rerender } = render(
      <CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />
    );
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy automatically.");
    });

    rerender(<CopyField value={`${URL_VALUE}-new`} label="Invite link" copyLabel="Copy link" />);

    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("never claims Copied for a copy that just failed, even right after one that worked", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      writable: true,
      configurable: true,
    });

    render(<CopyField value={URL_VALUE} label="Invite link" copyLabel="Copy link" />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await screen.findByRole("button", { name: "Copied" });

    writeText.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copied" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy automatically.");
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });
});
