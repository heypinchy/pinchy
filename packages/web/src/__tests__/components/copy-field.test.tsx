// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CopyField } from "@/components/copy-field";

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
    setShare(vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")));

    render(
      <CopyField
        value={URL_VALUE}
        label="Invite link"
        copyLabel="Copy link"
        share={{ title: "Pinchy invite" }}
      />
    );

    await user.click(await screen.findByRole("button", { name: "Share" }));

    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
