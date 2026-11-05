// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AccountGuard } from "@/components/account-guard";
import { navigation } from "@/lib/account-switch";

describe("AccountGuard (#1286)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reloads once when this browser holds another person's state, then watches for a switch", async () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-a");
    localStorage.setItem("pinchy:composer:draft:agent-1", "user-a's draft");

    const { unmount } = render(<AccountGuard userId="user-b" />);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBeNull();

    window.dispatchEvent(
      Object.assign(new Event("storage"), { key: "pinchy:account", newValue: "signed-out:1" })
    );
    expect(reload).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("does nothing on load for the person already recorded here", () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-b");

    render(<AccountGuard userId="user-b" />);

    expect(reload).not.toHaveBeenCalled();
  });

  // A browser where the record cannot stick would otherwise wipe and reload on
  // every load, forever, taking every page down with it.
  for (const method of ["getItem", "setItem"] as const) {
    it(`never reloads when storage ${method} throws`, async () => {
      const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("SecurityError");
      });

      render(<AccountGuard userId="user-b" />);
      // The claim is async: let it settle before asserting it did not reload.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reload).not.toHaveBeenCalled();
    });
  }

  it("reloads a page restored from the back/forward cache once someone else is recorded", () => {
    // A restored page re-runs no effect and missed every storage event while
    // it was frozen, so it checks again when it is shown.
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-a");
    render(<AccountGuard userId="user-a" />);

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

  it("does not reload a guard that unmounted while its claim was still running", async () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    let release: () => void = () => {};
    vi.stubGlobal("caches", {
      delete: () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    });
    try {
      localStorage.setItem("pinchy:account", "user-a");
      const { unmount } = render(<AccountGuard userId="user-b" />);

      unmount();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
