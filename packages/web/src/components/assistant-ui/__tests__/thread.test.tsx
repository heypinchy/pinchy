import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";
import { sendingOpacityClass } from "@/components/assistant-ui/thread";

vi.mock("@assistant-ui/react", () => ({
  MessagePrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Parts: () => null,
    Error: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  },
  useMessage: vi.fn(),
  useThread: vi.fn(),
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  UserMessageAttachments: () => null,
}));

vi.mock("@/components/assistant-ui/chat-error-message", () => ({
  ChatErrorMessage: () => <div data-testid="chat-error-message" />,
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
    RetryResendContext: React.createContext<(messageId: string) => void>(() => {}),
    RetryContinueContext: React.createContext<() => void>(() => {}),
  };
});

describe("sendingOpacityClass", () => {
  it("returns 'opacity-60' when status is 'sending'", () => {
    expect(sendingOpacityClass("sending")).toBe("opacity-60");
  });

  it("returns empty string when status is 'sent'", () => {
    expect(sendingOpacityClass("sent")).toBe("");
  });

  it("returns empty string when status is 'failed'", () => {
    expect(sendingOpacityClass("failed")).toBe("");
  });

  it("returns empty string when status is undefined", () => {
    expect(sendingOpacityClass(undefined)).toBe("");
  });
});

describe("UserMessage component", () => {
  it("applies opacity-60 to the content wrapper when status is 'sending'", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "sending" } }, isLast: false, id: "msg-1" })
    );

    const { UserMessage } = await import("@/components/assistant-ui/thread");
    const { container } = render(<UserMessage />);

    const wrapper = container.querySelector(".aui-user-message-content-wrapper");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveClass("opacity-60");
  });
});

describe("UserMessage failed state", () => {
  it("shows 'Couldn't deliver' and Retry button for the last failed user message", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: true, id: "msg-1" })
    );

    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(<UserMessage />);

    expect(screen.getByText("Couldn't deliver")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does NOT show Retry on a non-last failed message", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: false, id: "msg-1" })
    );

    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(<UserMessage />);

    expect(screen.queryByText("Couldn't deliver")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("calls onRetryResend with the message id when Retry is clicked", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: true, id: "msg-1" })
    );

    const mockRetryResend = vi.fn();
    const { RetryResendContext } = await import("@/components/chat");
    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(
      <RetryResendContext.Provider value={mockRetryResend}>
        <UserMessage />
      </RetryResendContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(mockRetryResend).toHaveBeenCalledWith("msg-1");
  });

  it("disables Retry button when isRunning is true", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: true }) : { isRunning: true }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: true, id: "msg-1" })
    );

    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(<UserMessage />);

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeDisabled();
  });
});

describe("AssistantMessage retryable error bubble", () => {
  it("shows Retry button on last assistant error bubble with retryable: true", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: true,
          id: "msg-err-1",
        })
    );

    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(<AssistantMessage />);

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does NOT show Retry button on non-last assistant error bubble", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: false,
          id: "msg-err-2",
        })
    );

    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(<AssistantMessage />);

    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("disables Retry button when isRunning is true", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: true }) : { isRunning: true }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: true,
          id: "msg-err-3",
        })
    );

    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(<AssistantMessage />);

    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
  });

  it("calls onRetryContinue when Retry is clicked", async () => {
    const { useMessage, useThread } = await import("@assistant-ui/react");
    vi.mocked(useThread).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector?: (state: any) => unknown) =>
        selector ? selector({ isRunning: false }) : { isRunning: false }
    );
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: true,
          id: "msg-err-4",
        })
    );

    const mockRetryContinue = vi.fn();
    const { RetryContinueContext } = await import("@/components/chat");
    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(
      <RetryContinueContext.Provider value={mockRetryContinue}>
        <AssistantMessage />
      </RetryContinueContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(mockRetryContinue).toHaveBeenCalledOnce();
  });
});
