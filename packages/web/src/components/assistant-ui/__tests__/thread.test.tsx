import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";
import { sendingOpacityClass } from "@/components/assistant-ui/thread";

// Mutable AuiIf state — lets individual tests flip thread.isRunning so we can
// exercise the Send/Cancel mutual-exclusion path covered by issue #207.
const auiState = vi.hoisted(() => ({ isRunning: false }));

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
  ThreadPrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div data-testid="thread-root" {...props}>
        {children}
      </div>
    ),
    Viewport: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div data-testid="thread-viewport" {...props}>
        {children}
      </div>
    ),
    Messages: () => <div data-testid="thread-messages" />,
    ViewportFooter: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <div {...props}>{children}</div>,
    ScrollToBottom: ({
      children,
      asChild: _asChild,
    }: {
      children?: React.ReactNode;
      asChild?: boolean;
    }) => <>{children}</>,
  },
  AuiIf: ({
    children,
    condition,
  }: {
    children?: React.ReactNode;
    condition: (s: Record<string, unknown>) => boolean;
  }) => {
    // For tests, we evaluate condition with a mock state. Tests can flip
    // `auiState.isRunning` to exercise the running/stopped branches.
    const show = condition({
      thread: { isRunning: auiState.isRunning },
      message: { isCopied: false },
    });
    return show ? <>{children}</> : null;
  },
  useMessage: vi.fn(),
  useComposerRuntime: vi.fn(() => null),
  useMessagePartFile: vi.fn(() => ({
    type: "file" as const,
    filename: "test.pdf",
    mimeType: "application/pdf",
    status: { type: "complete" },
  })),
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

  it("renders the image-too-large prompt when payloadRejected", async () => {
    await renderWith({ kind: "payloadRejected" });
    expect(screen.getByText(/image too large/i)).toBeInTheDocument();
    expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument();
  });
});

describe("Thread reconciling state", () => {
  it("unmounts messages while keeping the composer visible during guarded reconcile", async () => {
    const { Thread } = await import("@/components/assistant-ui/thread");
    render(<Thread isReconcilingMessages />);

    expect(screen.queryByTestId("thread-messages")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message input")).toBeInTheDocument();
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

  it("keeps input enabled but disables send when 'unavailable'", async () => {
    // Typing must never be blocked: a user mid-sentence shouldn't lose
    // their thought just because the WebSocket reconnects. Only Send is
    // gated on connection state.
    await renderComposerWith({ kind: "unavailable", reason: "disconnected" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("enables both input and send when 'ready'", async () => {
    await renderComposerWith({ kind: "ready" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();
  });

  it("enables send when the previous payload was rejected", async () => {
    await renderComposerWith({ kind: "payloadRejected" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();
  });

  it("keeps input enabled but disables send when 'starting'", async () => {
    // Same intent as the 'unavailable' case: let users start typing while
    // history loads; submission stays gated until the runtime is ready.
    await renderComposerWith({ kind: "starting" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("keeps input enabled but disables send when 'unavailable/configuring'", async () => {
    await renderComposerWith({ kind: "unavailable", reason: "configuring" });
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("keeps syncing text after a dead-key composition start does not emit compositionend", async () => {
    const { useComposerRuntime } = await import("@assistant-ui/react");
    const setText = vi.fn();
    vi.mocked(useComposerRuntime).mockReturnValue({
      getState: () => ({ isEditing: true }),
      setText,
    } as never);

    await renderComposerWith({ kind: "ready" });

    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "é" } });

    expect(setText).toHaveBeenCalledWith("é");
  });
});

describe("ComposerAction Send/Stop mutual exclusion (#207)", () => {
  beforeEach(() => {
    auiState.isRunning = false;
  });

  async function renderComposerWith(status: { kind: string; reason?: string }) {
    const { ChatStatusContext } = await import("@/components/chat");
    const { Composer } = await import("@/components/assistant-ui/thread");
    return render(
      <ChatStatusContext.Provider value={status as never}>
        <Composer />
      </ChatStatusContext.Provider>
    );
  }

  it("shows only Stop (not Send) while a generation is running", async () => {
    auiState.isRunning = true;
    // chat status is 'responding' mid-stream — the original bug rendered
    // both buttons disabled in this combination.
    await renderComposerWith({ kind: "responding" });

    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop generating/i })).toBeInTheDocument();
  });

  it("shows only Send (not Stop) when no generation is running", async () => {
    auiState.isRunning = false;
    await renderComposerWith({ kind: "ready" });

    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop generating/i })).not.toBeInTheDocument();
  });

  it("never shows both Send and Stop together, even during stuck generation", async () => {
    // Repro of the dead-end state from the issue: running + chat status not
    // ready (e.g. orphaned generation after a navigation).
    auiState.isRunning = true;
    await renderComposerWith({ kind: "unavailable", reason: "disconnected" });

    const sendBtn = screen.queryByRole("button", { name: /send message/i });
    const stopBtn = screen.queryByRole("button", { name: /stop generating/i });

    expect(sendBtn === null && stopBtn !== null).toBe(true);
  });
});

describe("FilePart component (re-exported AttachmentPreview)", () => {
  it("renders a PDF preview with embed thumbnail when MIME is application/pdf", async () => {
    // AttachmentPreview HEAD-probes the upload URL before mounting <embed>;
    // mock fetch so the probe resolves to 200 and the embed is rendered.
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;

    const { useMessagePartFile } = await import("@assistant-ui/react");
    vi.mocked(useMessagePartFile).mockReturnValue({
      mimeType: "application/pdf",
      filename: "report.pdf",
      data: "",
    } as never);
    const { FilePart } = await import("@/components/assistant-ui/thread");
    const { AgentIdContext } = await import("@/components/chat");
    const { container } = render(
      <AgentIdContext.Provider value="agent-1">
        <FilePart />
      </AgentIdContext.Provider>
    );
    await waitFor(() => {
      expect(container.querySelector("embed[type='application/pdf']")).toBeTruthy();
    });
  });

  it("renders a plain chip for an unknown MIME (regression: never silently drop the file)", async () => {
    const { useMessagePartFile } = await import("@assistant-ui/react");
    vi.mocked(useMessagePartFile).mockReturnValue({
      mimeType: "application/zip",
      filename: "archive.zip",
      data: "",
    } as never);
    const { FilePart } = await import("@/components/assistant-ui/thread");
    const { AgentIdContext } = await import("@/components/chat");
    render(
      <AgentIdContext.Provider value="agent-1">
        <FilePart />
      </AgentIdContext.Provider>
    );
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
  });

  it("falls back to 'PDF document' label when filename is missing", async () => {
    const { useMessagePartFile } = await import("@assistant-ui/react");
    vi.mocked(useMessagePartFile).mockReturnValue({
      mimeType: "application/pdf",
      filename: undefined,
      data: "",
    } as never);
    const { FilePart } = await import("@/components/assistant-ui/thread");
    render(<FilePart />);
    expect(screen.getByText(/PDF document/i)).toBeInTheDocument();
  });
});
