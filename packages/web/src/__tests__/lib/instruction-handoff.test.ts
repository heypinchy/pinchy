// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  canOfferInstructionHandoff,
  stashInstructionDraft,
  takeInstructionDraft,
  clearInstructionDraft,
  appendInstructionDraft,
} from "@/lib/instruction-handoff";

describe("appendInstructionDraft", () => {
  it("appends rather than replacing, so the existing instructions survive", () => {
    // The whole point of the handover is adding one rule to everything the
    // agent was already told. A replace would silently drop the rest.
    expect(appendInstructionDraft("Answer in English.", "Score leads by VUE.")).toBe(
      "Answer in English.\n\nScore leads by VUE.\n"
    );
  });

  it("separates the two blocks with a blank line", () => {
    // Without it, two Markdown paragraphs render as one.
    expect(appendInstructionDraft("a", "b")).toContain("a\n\nb");
  });

  it("does not open empty instructions with a blank line", () => {
    expect(appendInstructionDraft("", "First rule.")).toBe("First rule.\n");
    expect(appendInstructionDraft("   \n\n", "First rule.")).toBe("First rule.\n");
  });

  it("collapses the existing trailing whitespace instead of stacking blank lines", () => {
    expect(appendInstructionDraft("a\n\n\n", "b")).toBe("a\n\nb\n");
  });

  it("returns the existing content unchanged for a blank draft", () => {
    expect(appendInstructionDraft("a\n", "   \n ")).toBe("a\n");
  });
});

describe("instruction draft handoff", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a draft for one agent", () => {
    expect(stashInstructionDraft("agent-1", "Score leads by VUE.")).toBe(true);
    expect(takeInstructionDraft("agent-1")).toBe("Score leads by VUE.");
  });

  it("is keyed per agent, so a draft cannot surface in another agent's settings", () => {
    stashInstructionDraft("agent-1", "for one");

    expect(takeInstructionDraft("agent-2")).toBeNull();
    expect(takeInstructionDraft("agent-1")).toBe("for one");
  });

  it("consumes the draft, so re-opening the tab does not resurrect it", () => {
    // A stale draft reappearing during an unrelated edit is worse than losing
    // it: the user saves without noticing what came along.
    stashInstructionDraft("agent-1", "once");

    expect(takeInstructionDraft("agent-1")).toBe("once");
    expect(takeInstructionDraft("agent-1")).toBeNull();
  });

  it("refuses to stash a blank draft", () => {
    expect(stashInstructionDraft("agent-1", "   \n ")).toBe(false);
    expect(takeInstructionDraft("agent-1")).toBeNull();
  });

  it("clears without consuming into the caller", () => {
    stashInstructionDraft("agent-1", "abandoned");

    clearInstructionDraft("agent-1");

    expect(takeInstructionDraft("agent-1")).toBeNull();
  });

  describe("when the browser refuses storage", () => {
    // Safari private mode reports a quota of 0 and THROWS on setItem; a
    // storage-blocking policy throws on read. Neither is a reason to break the
    // chat — the text is still on screen and can be copied.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reports a failed stash instead of throwing", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

      expect(stashInstructionDraft("agent-1", "x")).toBe(false);
    });

    it("reads as no handoff instead of throwing", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("SecurityError");
      });

      expect(takeInstructionDraft("agent-1")).toBeNull();
    });
  });
});

describe("canOfferInstructionHandoff", () => {
  it("offers the handoff to someone who may save it", () => {
    expect(canOfferInstructionHandoff(true, "Score leads by VUE.")).toBe(true);
  });

  it("withholds it from a member on a shared agent", () => {
    // `canWriteAgent` is admin-or-personal-owner. Offering the action to
    // everyone and letting the API answer 403 would be the worse UI, and
    // #1145 is the real path for a member's proposal.
    expect(canOfferInstructionHandoff(false, "Score leads by VUE.")).toBe(false);
  });

  it("withholds it from a message with no text to carry", () => {
    // A pure tool-call or image turn has nothing to promote.
    expect(canOfferInstructionHandoff(true, "")).toBe(false);
    expect(canOfferInstructionHandoff(true, "  \n\t ")).toBe(false);
  });
});
