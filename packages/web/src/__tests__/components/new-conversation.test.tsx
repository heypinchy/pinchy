// @vitest-environment jsdom
// The "new conversation" state of a chat: the agent has greeted, the user has
// not written yet. Two things belong there (#1275):
//
// - the agent's starter prompts (#570). They used to sit behind
//   `thread.isEmpty`, but the server opens every new conversation with the
//   greeting as an assistant message, so the thread is never empty once the
//   chat is ready and the chips never rendered for anyone;
// - a one-time note on a shared agent with memory, saying that what you tell
//   it can shape what it tells your colleagues.
//
// These tests run the REAL assistant-ui runtime rather than a passthrough
// AuiIf mock: the bug was a gate evaluated against real thread state, and a
// mocked gate cannot see it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FC } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentIdContext: React.createContext<string | null>(null),
    ChatStatusContext: React.createContext<{ kind: string; reason?: string }>({ kind: "starting" }),
  };
});

type MockAgent = {
  isPersonal: boolean;
  starterPrompts: string[];
  allowedTools?: string[];
};
let mockAgent: MockAgent | undefined;
vi.mock("@/components/agents-provider", () => ({
  useAgentsContext: () => ({ getAgent: () => mockAgent }),
}));

import {
  NewConversationPrompts,
  SHARED_MEMORY_NOTICE_STORAGE_KEY,
} from "@/components/assistant-ui/new-conversation";
import { AgentIdContext, ChatStatusContext } from "@/components/chat";

const greeting: ThreadMessageLike = { role: "assistant", content: "Hi, I'm Ada." };
const userTurn: ThreadMessageLike = { role: "user", content: "What is our leave policy?" };

const Harness: FC<{
  messages: ThreadMessageLike[];
  status?: "ready" | "starting";
  onRuntime?: (runtime: AssistantRuntime) => void;
}> = ({ messages, status = "ready", onRuntime }) => {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  onRuntime?.(runtime);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatStatusContext.Provider value={{ kind: status }}>
        <AgentIdContext.Provider value="agent-1">
          <ThreadPrimitive.Root>
            <NewConversationPrompts />
          </ThreadPrimitive.Root>
        </AgentIdContext.Provider>
      </ChatStatusContext.Provider>
    </AssistantRuntimeProvider>
  );
};

const sharedKbAgent: MockAgent = {
  isPersonal: false,
  starterPrompts: ["Summarize the onboarding guide", "What does the travel policy say?"],
  allowedTools: ["knowledge_search", "pinchy_memory"],
};

beforeEach(() => {
  mockAgent = undefined;
  window.localStorage.clear();
});

describe("NewConversationPrompts — starter prompts", () => {
  it("shows the starter prompts under the greeting before the user has written", () => {
    mockAgent = sharedKbAgent;
    render(<Harness messages={[greeting]} />);
    expect(screen.getByText("Summarize the onboarding guide")).toBeInTheDocument();
    expect(screen.getByText("What does the travel policy say?")).toBeInTheDocument();
  });

  it("hides the starter prompts once the user has written", () => {
    mockAgent = sharedKbAgent;
    render(<Harness messages={[greeting, userTurn]} />);
    expect(screen.queryByText("Summarize the onboarding guide")).not.toBeInTheDocument();
  });

  it("shows nothing while the chat is still connecting", () => {
    mockAgent = sharedKbAgent;
    render(<Harness messages={[greeting]} status="starting" />);
    expect(screen.queryByText("Summarize the onboarding guide")).not.toBeInTheDocument();
  });

  it("steps aside while the user is typing, so a chip can't wipe their draft", async () => {
    // A chip sends its prompt and then clears the composer (assistant-ui's
    // Suggestion default), which would throw away a half-written question.
    mockAgent = sharedKbAgent;
    let runtime: AssistantRuntime | undefined;
    render(<Harness messages={[greeting]} onRuntime={(r) => (runtime = r)} />);
    expect(screen.getByText("Summarize the onboarding guide")).toBeInTheDocument();

    await act(async () => runtime!.thread.composer.setText("What does our travel"));
    await waitFor(() =>
      expect(screen.queryByText("Summarize the onboarding guide")).not.toBeInTheDocument()
    );

    await act(async () => runtime!.thread.composer.setText(""));
    await waitFor(() =>
      expect(screen.getByText("Summarize the onboarding guide")).toBeInTheDocument()
    );
  });

  it("leaves the empty thread to ThreadWelcome", () => {
    mockAgent = sharedKbAgent;
    render(<Harness messages={[]} />);
    expect(screen.queryByText("Summarize the onboarding guide")).not.toBeInTheDocument();
  });
});

describe("NewConversationPrompts — shared memory notice", () => {
  const noticeText = /can become part of what it remembers/i;

  it("tells a member that a shared agent with memory learns from their chat", () => {
    mockAgent = sharedKbAgent;
    render(<Harness messages={[greeting]} />);
    expect(screen.getByText(noticeText)).toBeInTheDocument();
  });

  it("says nothing on a personal agent", () => {
    mockAgent = { ...sharedKbAgent, isPersonal: true };
    render(<Harness messages={[greeting]} />);
    expect(screen.queryByText(noticeText)).not.toBeInTheDocument();
  });

  it("says nothing on a shared agent without memory — the claim would be false", () => {
    mockAgent = { ...sharedKbAgent, allowedTools: ["knowledge_search"] };
    render(<Harness messages={[greeting]} />);
    expect(screen.queryByText(noticeText)).not.toBeInTheDocument();
  });

  it("stays while the user types — that is when it matters", async () => {
    mockAgent = sharedKbAgent;
    let runtime: AssistantRuntime | undefined;
    render(<Harness messages={[greeting]} onRuntime={(r) => (runtime = r)} />);

    await act(async () => runtime!.thread.composer.setText("Our client Müller asked"));
    // The chips step aside (a click would clear the draft)...
    await waitFor(() =>
      expect(screen.queryByText("Summarize the onboarding guide")).not.toBeInTheDocument()
    );
    // ...but the note about what the agent remembers does not.
    expect(screen.getByText(noticeText)).toBeInTheDocument();
  });

  it("is shown once: dismissing it keeps it gone on the next new chat", () => {
    mockAgent = sharedKbAgent;
    const { unmount } = render(<Harness messages={[greeting]} />);
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(screen.queryByText(noticeText)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SHARED_MEMORY_NOTICE_STORAGE_KEY)).not.toBeNull();
    unmount();

    render(<Harness messages={[greeting]} />);
    expect(screen.queryByText(noticeText)).not.toBeInTheDocument();
    // The starter prompts are not part of what was dismissed.
    expect(screen.getByText("Summarize the onboarding guide")).toBeInTheDocument();
  });

  it("keeps its dismissal under the pinchy: prefix, so an account switch resets it", () => {
    // wipePinchyStorage() (lib/account-switch.ts) clears only `pinchy:` keys
    // when someone else signs in. A dismissal outside that prefix would hide
    // this note from the next person on a shared computer.
    expect(SHARED_MEMORY_NOTICE_STORAGE_KEY.startsWith("pinchy:")).toBe(true);
  });

  it("still shows when browser storage is unavailable", () => {
    mockAgent = sharedKbAgent;
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      render(<Harness messages={[greeting]} />);
      expect(screen.getByText(noticeText)).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });
});
