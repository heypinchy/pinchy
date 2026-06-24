// Behavioural guard for the composer draft cache, rendered against the REAL
// assistant-ui composer (no mock) and the REAL in-memory draft store.
//
// Bug history: the composer draft was keyed by agentId alone, so a draft typed
// in one chat surfaced in a sibling chat of the same agent ("bleed"), survived a
// send, and reappeared after being deleted (the "resurrection"). The fix keys
// the draft per (agentId, chatId), persists on every composer change, and lets
// the empty-auto-clear in saveDraft handle both send and manual deletion.
//
// Why a real-dependency test and not a mock: the sibling thread.test.tsx mocks
// @assistant-ui/react wholesale, so DraftPersistence's reliance on the live
// composer runtime (subscribe / setText / getState) is invisible there. This
// file renders the real ComposerPrimitive against a real useExternalStoreRuntime
// so a dependency change that breaks the draft contract shows up HERE.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useEffect, type FC } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useComposerRuntime,
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type ComposerRuntime,
} from "@assistant-ui/react";
import { DraftPersistence } from "@/components/assistant-ui/thread";
import { AgentIdContext, ChatIdContext } from "@/components/chat";
import { getDraft, clearDraft, draftKey } from "@/lib/draft-store";

const AGENT = "agent-1";

let composerApi: ComposerRuntime | null = null;
const CaptureComposer: FC = () => {
  const composer = useComposerRuntime();
  useEffect(() => {
    composerApi = composer;
  }, [composer]);
  return null;
};

// Mirrors the production tree: DraftPersistence lives inside the composer of a
// runtime created per (agent, chat). Each mount gets its OWN runtime, exactly
// like production where switching chats remounts <Chat> against that chat's
// background runtime.
const Harness: FC<{ chatId: string | null }> = ({ chatId }) => {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    isRunning: false,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return (
    <AgentIdContext.Provider value={AGENT}>
      <ChatIdContext.Provider value={chatId}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ComposerPrimitive.Root>
            <CaptureComposer />
            <DraftPersistence />
            <ComposerPrimitive.Input aria-label="Message input" />
          </ComposerPrimitive.Root>
        </AssistantRuntimeProvider>
      </ChatIdContext.Provider>
    </AgentIdContext.Provider>
  );
};

function type(text: string) {
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  act(() => {
    fireEvent.change(textarea, { target: { value: text } });
  });
}

describe("DraftPersistence (per-chat composer draft)", () => {
  beforeEach(() => {
    clearDraft(draftKey(AGENT));
    clearDraft(draftKey(AGENT, "chat-a"));
    clearDraft(draftKey(AGENT, "chat-b"));
    composerApi = null;
  });

  it("saves the draft under the (agent, chat) key as the user types", () => {
    render(<Harness chatId="chat-a" />);
    type("hello from A");

    expect(getDraft(draftKey(AGENT, "chat-a"))?.text).toBe("hello from A");
    // No bleed onto the agent-level or sibling keys.
    expect(getDraft(draftKey(AGENT))).toBeUndefined();
    expect(getDraft(draftKey(AGENT, "chat-b"))).toBeUndefined();
  });

  it("does NOT bleed a draft into a sibling chat of the same agent", () => {
    const { unmount } = render(<Harness chatId="chat-a" />);
    type("hello from A");
    unmount();

    // Switch to a different chat of the SAME agent — its composer must be empty.
    render(<Harness chatId="chat-b" />);
    expect(composerApi!.getState().text).toBe("");
    expect(getDraft(draftKey(AGENT, "chat-b"))).toBeUndefined();
    // Chat A's draft is untouched.
    expect(getDraft(draftKey(AGENT, "chat-a"))?.text).toBe("hello from A");
  });

  it("restores the draft when returning to the same chat", () => {
    const first = render(<Harness chatId="chat-a" />);
    type("draft to keep");
    first.unmount();

    render(<Harness chatId="chat-a" />);
    expect(composerApi!.getState().text).toBe("draft to keep");
  });

  it("clears the draft when the composer is emptied (manual delete sticks)", () => {
    render(<Harness chatId="chat-a" />);
    type("oops");
    expect(getDraft(draftKey(AGENT, "chat-a"))?.text).toBe("oops");

    // Delete the text — the cleared state must persist, not resurrect.
    type("");
    expect(getDraft(draftKey(AGENT, "chat-a"))).toBeUndefined();
  });

  it("clears the draft on send", async () => {
    render(<Harness chatId="chat-a" />);
    type("send me");
    expect(getDraft(draftKey(AGENT, "chat-a"))?.text).toBe("send me");

    await act(async () => {
      await composerApi!.send();
    });

    expect(composerApi!.getState().text).toBe("");
    expect(getDraft(draftKey(AGENT, "chat-a"))).toBeUndefined();
  });
});
