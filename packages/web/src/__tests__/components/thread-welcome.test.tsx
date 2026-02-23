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

import { Thread } from "@/components/assistant-ui/thread";
import { STARTUP_MESSAGES } from "@/components/assistant-ui/thread";

describe("ThreadWelcome startup messages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a startup message from the known list", () => {
    render(<Thread />);
    const messageEl = screen.getByTestId("startup-message");
    expect(STARTUP_MESSAGES).toContain(messageEl.textContent);
  });

  it("does not show the old 'Hello there' greeting", () => {
    render(<Thread />);
    expect(screen.queryByText("Hello there!")).not.toBeInTheDocument();
  });

  it("does not show the old privacy notice", () => {
    render(<Thread />);
    expect(screen.queryByText(/conversations help build team knowledge/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/conversations are private/i)).not.toBeInTheDocument();
  });

  it("shows 'Starting agent...' heading", () => {
    render(<Thread />);
    expect(screen.getByText("Starting agent...")).toBeInTheDocument();
  });

  it("rotates to a different message after interval", () => {
    render(<Thread />);
    const firstMessage = screen.getByTestId("startup-message").textContent;

    // Advance past the rotation interval (3 seconds)
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    const secondMessage = screen.getByTestId("startup-message").textContent;
    // Both should be valid messages
    expect(STARTUP_MESSAGES).toContain(firstMessage);
    expect(STARTUP_MESSAGES).toContain(secondMessage);
  });
});
