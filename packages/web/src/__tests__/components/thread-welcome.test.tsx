import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("@assistant-ui/react", () => ({
  ThreadPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Viewport: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Messages: () => null,
    ViewportFooter: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    ScrollToBottom: ({ children }: any) => <div>{children}</div>,
    Suggestions: () => null,
  },
  AuiIf: ({ children }: any) => <>{children}</>,
  ComposerPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    AttachmentDropzone: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Input: (props: any) => <input {...props} />,
    Send: ({ children }: any) => <div>{children}</div>,
    Cancel: ({ children }: any) => <div>{children}</div>,
  },
  SuggestionPrimitive: {
    Trigger: ({ children }: any) => <div>{children}</div>,
    Title: () => null,
    Description: () => null,
  },
  ActionBarPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Copy: ({ children }: any) => <div>{children}</div>,
    ExportMarkdown: ({ children }: any) => <div>{children}</div>,
  },
  ActionBarMorePrimitive: {
    Root: ({ children }: any) => <div>{children}</div>,
    Trigger: ({ children }: any) => <div>{children}</div>,
    Content: ({ children }: any) => <div>{children}</div>,
    Item: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  ErrorPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Message: (props: any) => <div {...props} />,
  },
  MessagePrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Parts: () => null,
    Error: ({ children }: any) => <div>{children}</div>,
  },
  useMessage: () => ({}),
  useComposerRuntime: () => null,
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  ComposerAddAttachment: () => null,
  ComposerAttachments: () => null,
  UserMessageAttachments: () => null,
}));

vi.mock("@/components/assistant-ui/chat-image", () => ({
  ChatImage: () => null,
}));

vi.mock("@/components/assistant-ui/markdown-text", () => ({
  MarkdownText: () => null,
}));

vi.mock("@/components/assistant-ui/tool-fallback", () => ({
  ToolFallback: () => null,
}));

vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
    RetryResendContext: React.createContext<(messageId: string) => void>(() => {}),
    RetryContinueContext: React.createContext<() => void>(() => {}),
    ChatStatusContext: React.createContext<{ kind: string; reason?: string }>({ kind: "starting" }),
  };
});

import { ThreadWelcome, STARTUP_MESSAGES } from "@/components/assistant-ui/thread";
import { ChatStatusContext } from "@/components/chat";

describe("ThreadWelcome — loading state (kind=starting)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'Starting agent...' heading", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "starting" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(screen.getByText("Starting agent...")).toBeInTheDocument();
  });

  it("shows a startup message from the known list", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "starting" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    const messageEl = screen.getByTestId("startup-message");
    expect(STARTUP_MESSAGES).toContain(messageEl.textContent);
  });

  it("shows the spinner animation", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "starting" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument();
  });

  it("rotates to a different message after interval", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "starting" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    const firstMessage = screen.getByTestId("startup-message").textContent;

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    const secondMessage = screen.getByTestId("startup-message").textContent;
    expect(STARTUP_MESSAGES).toContain(firstMessage);
    expect(STARTUP_MESSAGES).toContain(secondMessage);
  });
});

describe("ThreadWelcome — ready state (kind=ready)", () => {
  // The ready/responding empty-thread state renders nothing. Every agent has a
  // greetingMessage, so the server's opening assistant bubble is the welcome.
  // Rendering anything else here would cause a flash during the assistant-ui
  // store sync window, after the React state already says ready=true.
  it("renders nothing when ready and the thread is empty", () => {
    const { container } = render(
      <ChatStatusContext.Provider value={{ kind: "ready" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when responding and the thread is empty", () => {
    const { container } = render(
      <ChatStatusContext.Provider value={{ kind: "responding" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ThreadWelcome — disconnected state (kind=unavailable, reason=disconnected)", () => {
  it("shows the 'Reconnecting...' message", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "unavailable", reason: "disconnected" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(screen.getByText(/reconnecting to the agent/i)).toBeInTheDocument();
  });

  it("shows the spinner animation (we are still trying to reach the agent)", () => {
    render(
      <ChatStatusContext.Provider value={{ kind: "unavailable", reason: "disconnected" }}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument();
  });
});
