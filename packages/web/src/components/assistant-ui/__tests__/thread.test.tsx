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
  ComposerPrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <form {...props}>{children}</form>
    ),
    AttachmentDropzone: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <div {...props}>{children}</div>,
    Input: ({ disabled, ...props }: { disabled?: boolean; [key: string]: unknown }) => (
      <textarea disabled={disabled} aria-label="Message input" {...props} />
    ),
    Send: ({
      children,
      disabled,
      asChild,
      ...props
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      asChild?: boolean;
      [key: string]: unknown;
    }) => {
      if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement<{ disabled?: boolean }>, {
          disabled:
            disabled ?? (children as React.ReactElement<{ disabled?: boolean }>).props.disabled,
        });
      }
      return (
        <button disabled={disabled} {...props}>
          {children}
        </button>
      );
    },
    Cancel: ({
      children,
      asChild,
      ...props
    }: {
      children?: React.ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) => {
      if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement);
      }
      return <button {...props}>{children}</button>;
    },
    Attachments: () => null,
    AddAttachment: () => null,
  },
  AuiIf: ({
    children,
    condition,
  }: {
    children?: React.ReactNode;
    condition: (s: Record<string, unknown>) => boolean;
  }) => {
    // For tests, we evaluate condition with a mock state
    const show = condition({ thread: { isRunning: false }, message: { isCopied: false } });
    return show ? <>{children}</> : null;
  },
  useMessage: vi.fn(),
  useComposerRuntime: vi.fn(() => null),
}));

vi.mock("@/lib/draft-store", () => ({
  getDraft: vi.fn(() => null),
  saveDraft: vi.fn(),
}));

vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    disabled,
    "aria-label": ariaLabel,
    ...props
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    "aria-label"?: string;
    [key: string]: unknown;
  }) => (
    <button disabled={disabled} aria-label={ariaLabel} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  UserMessageAttachments: () => null,
  ComposerAttachments: () => null,
  ComposerAddAttachment: () => null,
}));

vi.mock("@/components/assistant-ui/chat-error-message", () => ({
  ChatErrorMessage: ({ actionSlot }: { actionSlot?: React.ReactNode }) => (
    <div data-testid="chat-error-message">{actionSlot}</div>
  ),
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
    RetryResendContext: React.createContext<(messageId: string) => void>(() => {}),
    RetryContinueContext: React.createContext<() => void>(() => {}),
    ChatStatusContext: React.createContext<{ kind: string; reason?: string }>({ kind: "ready" }),
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
    const { useMessage } = await import("@assistant-ui/react");
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
    const { useMessage } = await import("@assistant-ui/react");
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
    const { useMessage } = await import("@assistant-ui/react");
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
    const { useMessage } = await import("@assistant-ui/react");
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

  it("disables Retry button when ChatStatusContext is responding", async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: true, id: "msg-1" })
    );

    const { ChatStatusContext } = await import("@/components/chat");
    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(
      <ChatStatusContext.Provider value={{ kind: "responding" }}>
        <UserMessage />
      </ChatStatusContext.Provider>
    );

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeDisabled();
  });

  it("disables Retry button and sets tooltip when ChatStatusContext is unavailable", async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "failed" } }, isLast: true, id: "msg-1" })
    );

    const { ChatStatusContext } = await import("@/components/chat");
    const { UserMessage } = await import("@/components/assistant-ui/thread");
    render(
      <ChatStatusContext.Provider value={{ kind: "unavailable", reason: "disconnected" }}>
        <UserMessage />
      </ChatStatusContext.Provider>
    );

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveAttribute("title");
    expect(retryButton.getAttribute("title")).toMatch(/agent/i);
  });
});

describe("ThreadWelcome", () => {
  async function renderWith(status: { kind: string; reason?: string }) {
    const { ChatStatusContext } = await import("@/components/chat");
    const { ThreadWelcome } = await import("@/components/assistant-ui/thread");
    return render(
      <ChatStatusContext.Provider value={status as never}>
        <ThreadWelcome />
      </ChatStatusContext.Provider>
    );
  }

  it("renders a skeleton when starting", async () => {
    await renderWith({ kind: "starting" });
    expect(screen.getByTestId("welcome-skeleton")).toBeInTheDocument();
  });

  it("renders nothing when ready (the agent's own greeting is the welcome)", async () => {
    const { container } = await renderWith({ kind: "ready" });
    // ThreadWelcome's ready branch returns null — every agent ships a
    // greetingMessage and the server's opening assistant bubble is the welcome.
    expect(container.querySelector('[data-testid="welcome-skeleton"]')).toBeNull();
    expect(container.textContent).not.toMatch(/how can i help you/i);
  });

  it("renders 'Reconnecting...' when unavailable/disconnected", async () => {
    await renderWith({ kind: "unavailable", reason: "disconnected" });
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it("renders 'Just a moment...' when unavailable/configuring", async () => {
    await renderWith({ kind: "unavailable", reason: "configuring" });
    expect(screen.getByText(/just a moment/i)).toBeInTheDocument();
  });

  it("renders the reload prompt when unavailable/exhausted", async () => {
    await renderWith({ kind: "unavailable", reason: "exhausted" });
    expect(screen.getByText(/please reload/i)).toBeInTheDocument();
  });
});

describe("AssistantMessage retryable error bubble", () => {
  it("shows Retry button on last assistant error bubble with retryable: true", async () => {
    const { useMessage } = await import("@assistant-ui/react");
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
    const { useMessage } = await import("@assistant-ui/react");
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

  it("disables Retry button when ChatStatusContext is responding", async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: true,
          id: "msg-err-3",
        })
    );

    const { ChatStatusContext } = await import("@/components/chat");
    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(
      <ChatStatusContext.Provider value={{ kind: "responding" }}>
        <AssistantMessage />
      </ChatStatusContext.Provider>
    );

    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
  });

  it("disables Retry button and sets tooltip when ChatStatusContext is unavailable", async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          metadata: { custom: { error: { disconnected: true }, retryable: true } },
          isLast: true,
          id: "msg-err-5",
        })
    );

    const { ChatStatusContext } = await import("@/components/chat");
    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(
      <ChatStatusContext.Provider value={{ kind: "unavailable", reason: "disconnected" }}>
        <AssistantMessage />
      </ChatStatusContext.Provider>
    );

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveAttribute("title");
    expect(retryButton.getAttribute("title")).toMatch(/agent/i);
  });

  it("calls onRetryContinue when Retry is clicked", async () => {
    const { useMessage } = await import("@assistant-ui/react");
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

describe("Composer input vs send disabled state", () => {
  async function renderComposerWith(status: { kind: string; reason?: string }) {
    const { ChatStatusContext } = await import("@/components/chat");
    const { Composer } = await import("@/components/assistant-ui/thread");
    return render(
      <ChatStatusContext.Provider value={status as never}>
        <Composer />
      </ChatStatusContext.Provider>
    );
  }

  it("keeps the input enabled during 'responding'", async () => {
    await renderComposerWith({ kind: "responding" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });

  it("disables the send button during 'responding'", async () => {
    await renderComposerWith({ kind: "responding" });
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("disables both input and send when 'unavailable'", async () => {
    await renderComposerWith({ kind: "unavailable", reason: "disconnected" });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("enables both input and send when 'ready'", async () => {
    await renderComposerWith({ kind: "ready" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();
  });

  it("disables both input and send when 'starting'", async () => {
    await renderComposerWith({ kind: "starting" });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });
});
