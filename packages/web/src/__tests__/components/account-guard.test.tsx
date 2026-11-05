// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { AccountGuard } from "@/components/account-guard";
import { navigation } from "@/lib/account-switch";

describe("AccountGuard (#1286)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reloads once when this browser holds another person's state, then watches for a switch", () => {
    const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
    localStorage.setItem("pinchy:account", "user-a");
    localStorage.setItem("pinchy:composer:draft:agent-1", "user-a's draft");

    const { unmount } = render(<AccountGuard userId="user-b" />);

    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "pinchy:account", newValue: "signed-out:1" })
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
    it(`never reloads when storage ${method} throws`, () => {
      const reload = vi.spyOn(navigation, "reload").mockImplementation(() => {});
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("SecurityError");
      });

      render(<AccountGuard userId="user-b" />);

      expect(reload).not.toHaveBeenCalled();
    });
  }
});
