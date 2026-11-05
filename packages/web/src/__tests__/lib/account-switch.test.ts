// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: mockSignOut } }));

import { enterAccount, leaveAccount, navigation } from "@/lib/account-switch";

/**
 * A shared browser must not hand one person's client-side state to the next
 * (#1286). Drafts, staged-upload draft ids and the last-chat pointer live in
 * localStorage under `pinchy:` with no user in the key, and module-level caches
 * (the chat list, in-memory drafts) survive a client-side navigation. So
 * leaving an account wipes that storage and reloads the page, and entering one
 * does the same when someone else was signed in here last — which also covers
 * a session that expired without anybody signing out.
 */
describe("account switch on a shared browser (#1286)", () => {
  let assign: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSignOut.mockReset().mockResolvedValue(undefined);
    assign = vi.spyOn(navigation, "assign").mockImplementation(() => {});
  });

  function seedPreviousUsersState() {
    localStorage.setItem("pinchy:composer:draft:agent-1", "half-written reply");
    localStorage.setItem("pinchy:composer:agent-1:draftId", "draft-uuid");
    localStorage.setItem("pinchy:lastChat:agent-1", "chat-9");
    localStorage.setItem("theme", "dark");
    sessionStorage.setItem("pinchy:instruction-handoff:agent-1", "secret instruction");
  }

  it("signs out, wipes this browser's Pinchy storage, and reloads into the login page", async () => {
    seedPreviousUsersState();

    await leaveAccount();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBeNull();
    expect(localStorage.getItem("pinchy:composer:agent-1:draftId")).toBeNull();
    expect(localStorage.getItem("pinchy:lastChat:agent-1")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    // Not Pinchy's to clear: a device preference, not a person's data.
    expect(localStorage.getItem("theme")).toBe("dark");
    // A full load, not a client-side push: module-level caches must not survive.
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("wipes the previous person's storage when someone else signs in here", () => {
    enterAccount("user-a", "/");
    seedPreviousUsersState();

    enterAccount("user-b", "/chat");

    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(assign).toHaveBeenLastCalledWith("/chat");
  });

  it("keeps the person's own drafts when they sign back in after their session expired", () => {
    enterAccount("user-a", "/");
    seedPreviousUsersState();

    enterAccount("user-a", "/");

    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBe("half-written reply");
    expect(assign).toHaveBeenLastCalledWith("/");
  });

  it("wipes when it cannot tell who was here before", () => {
    seedPreviousUsersState();

    enterAccount("user-a", "/");

    expect(localStorage.getItem("pinchy:composer:draft:agent-1")).toBeNull();
  });

  it("still signs in when storage is unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      enterAccount("user-a", "/");
      expect(assign).toHaveBeenCalledWith("/");
    } finally {
      getItem.mockRestore();
    }
  });
});
