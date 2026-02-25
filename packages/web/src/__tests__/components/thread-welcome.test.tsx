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
  };
});

import { Thread } from "@/components/assistant-ui/thread";
import { STARTUP_MESSAGES } from "@/components/assistant-ui/thread";
import { AgentAvatarContext } from "@/components/chat";

describe("ThreadWelcome — loading state (isHistoryLoaded=false)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'Starting agent...' heading", () => {
    render(<Thread isHistoryLoaded={false} />);
    expect(screen.getByText("Starting agent...")).toBeInTheDocument();
  });

  it("shows a startup message from the known list", () => {
    render(<Thread isHistoryLoaded={false} />);
    const messageEl = screen.getByTestId("startup-message");
    expect(STARTUP_MESSAGES).toContain(messageEl.textContent);
  });

  it("shows the spinner animation", () => {
    render(<Thread isHistoryLoaded={false} />);
    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument();
  });

  it("rotates to a different message after interval", () => {
    render(<Thread isHistoryLoaded={false} />);
    const firstMessage = screen.getByTestId("startup-message").textContent;

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    const secondMessage = screen.getByTestId("startup-message").textContent;
    expect(STARTUP_MESSAGES).toContain(firstMessage);
    expect(STARTUP_MESSAGES).toContain(secondMessage);
  });
});

describe("ThreadWelcome — ready state (isHistoryLoaded=true)", () => {
  it("shows 'How can I help you?' instead of 'Starting agent...'", () => {
    render(<Thread isHistoryLoaded={true} />);
    expect(screen.getByText("How can I help you?")).toBeInTheDocument();
    expect(screen.queryByText("Starting agent...")).not.toBeInTheDocument();
  });

  it("does NOT show the spinner animation", () => {
    render(<Thread isHistoryLoaded={true} />);
    expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument();
  });

  it("does NOT show startup messages", () => {
    render(<Thread isHistoryLoaded={true} />);
    expect(screen.queryByTestId("startup-message")).not.toBeInTheDocument();
  });

  it("shows avatar in ready state when provided via context", () => {
    const { container } = render(
      <AgentAvatarContext.Provider value="data:image/svg+xml;utf8,test-avatar">
        <Thread isHistoryLoaded={true} />
      </AgentAvatarContext.Provider>
    );
    const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,test-avatar"]');
    expect(avatar).toBeInTheDocument();
  });

  it("does not show avatar in ready state when context is null", () => {
    const { container } = render(
      <AgentAvatarContext.Provider value={null}>
        <Thread isHistoryLoaded={true} />
      </AgentAvatarContext.Provider>
    );
    const avatars = container.querySelectorAll("img");
    expect(avatars.length).toBe(0);
  });
});
