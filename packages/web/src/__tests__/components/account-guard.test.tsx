// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect, useState } from "react";
import { render } from "@testing-library/react";
import { AccountGuard } from "@/components/account-guard";
import { navigation } from "@/lib/account-switch";

/** Reads a draft the way the composer does: during its first render. */
function DraftReader({ onRead }: { onRead: (draft: string | null) => void }) {
  useState(() => onRead(localStorage.getItem("pinchy:composer:draft:agent-1")));
  return null;
}

/** Writes Pinchy keys on load, the way useDraftId and recordLastChat do. */
function PageThatWritesStorage() {
  useState(() => localStorage.setItem("pinchy:composer:agent-1:draftId", "fresh-id"));
  useEffect(() => localStorage.setItem("pinchy:lastChat:agent-1", "chat-1"), []);
  return null;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AccountGuard (#1286)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("clears another person's storage before anything under it renders, without a reload", async () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-a");
    localStorage.setItem("pinchy:composer:draft:agent-1", "user-a's draft");
    const onRead = vi.fn();

    render(
      <AccountGuard userId="user-b">
        <DraftReader onRead={onRead} />
      </AccountGuard>
    );
    await settle();

    expect(onRead).toHaveBeenCalledWith(null);
    expect(localStorage.getItem("pinchy:account")).toBe("user-b");
    // A full load has no in-memory state from anyone else, so nothing to reload.
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves the recorded person's own storage alone", () => {
    localStorage.setItem("pinchy:account", "user-b");
    localStorage.setItem("pinchy:composer:draft:agent-1", "my draft");
    const onRead = vi.fn();

    render(
      <AccountGuard userId="user-b">
        <DraftReader onRead={onRead} />
      </AccountGuard>
    );

    expect(onRead).toHaveBeenCalledWith("my draft");
  });

  it("never wipes or reloads what the page itself writes on load", async () => {
    // A fresh browser (or an E2E context signed in over the API) has no
    // record; the page then writes its own keys while it mounts.
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});

    render(
      <AccountGuard userId="user-b">
        <PageThatWritesStorage />
      </AccountGuard>
    );
    await settle();

    expect(localStorage.getItem("pinchy:composer:agent-1:draftId")).toBe("fresh-id");
    expect(localStorage.getItem("pinchy:lastChat:agent-1")).toBe("chat-1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when another tab signs out or signs in as somebody else", () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    const { unmount } = render(<AccountGuard userId="user-b">{null}</AccountGuard>);

    window.dispatchEvent(
      Object.assign(new Event("storage"), { key: "pinchy:account", newValue: "signed-out:1" })
    );
    expect(reload).toHaveBeenCalledTimes(1);

    unmount();
    window.dispatchEvent(
      Object.assign(new Event("storage"), { key: "pinchy:account", newValue: "user-c" })
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Storage that cannot be read or written must never turn into a reload loop.
  for (const method of ["getItem", "setItem"] as const) {
    it(`still renders, and never reloads, when storage ${method} throws`, async () => {
      const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("SecurityError");
      });

      const { getByText } = render(
        <AccountGuard userId="user-b">
          <p>app</p>
        </AccountGuard>
      );
      await settle();

      expect(getByText("app")).toBeTruthy();
      expect(reload).not.toHaveBeenCalled();
    });
  }

  it("reloads a page restored from the back/forward cache once someone else is recorded", () => {
    // A restored page re-runs no effect and missed every storage event while
    // it was frozen, so it checks again when it is shown.
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-a");
    render(<AccountGuard userId="user-a">{null}</AccountGuard>);

    const pageshow = (persisted: boolean) =>
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

    pageshow(true);
    expect(reload).not.toHaveBeenCalled();

    localStorage.setItem("pinchy:account", "signed-out:1");
    pageshow(false);
    expect(reload).not.toHaveBeenCalled();
    pageshow(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
