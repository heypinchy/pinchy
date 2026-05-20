import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";

// We mock @assistant-ui/react so the ActionBar primitives render their
// children inline (no portals, no popovers). That way the menu entry is
// directly visible in the DOM and we can click it in JSDOM.
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
    Input: (props: Record<string, unknown>) => <textarea {...props} />,
    Send: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Cancel: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Attachments: () => null,
    AddAttachment: () => null,
  },
  ThreadPrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Viewport: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Messages: () => null,
    ViewportFooter: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => <div {...props}>{children}</div>,
    ScrollToBottom: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  },
  AuiIf: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  ActionBarPrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Copy: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    // ExportMarkdown wraps a child via asChild; render the child directly.
    ExportMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  },
  ActionBarMorePrimitive: {
    Root: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Content: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Item: ({
      children,
      onSelect,
      ...props
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
      [key: string]: unknown;
    }) => (
      <button type="button" onClick={onSelect} {...props}>
        {children}
      </button>
    ),
  },
  ErrorPrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Message: (props: Record<string, unknown>) => <div {...props} />,
  },
  useMessage: vi.fn(),
  useComposerRuntime: vi.fn(() => null),
  useMessagePartFile: vi.fn(),
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  UserMessageAttachments: () => null,
  ComposerAttachments: () => null,
  ComposerAddAttachment: () => null,
}));

vi.mock("@/components/assistant-ui/markdown-text", () => ({
  MarkdownText: () => null,
}));

vi.mock("@/components/assistant-ui/tool-fallback", () => ({
  ToolFallback: () => null,
}));

vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/assistant-ui/chat-error-message", () => ({
  ChatErrorMessage: () => null,
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
    AgentNameContext: React.createContext<string | null>(null),
    RetryResendContext: React.createContext<(messageId: string) => void>(() => {}),
    RetryContinueContext: React.createContext<() => void>(() => {}),
    ChatStatusContext: React.createContext<{ kind: string; reason?: string }>({ kind: "ready" }),
  };
});

// Stub the DiagnosticsExportDialog so the test can assert the props it
// receives via DOM attributes rather than reaching into the real Dialog
// (which uses Radix portals and breaks the JSDOM accessibility tree).
vi.mock("@/components/diagnostics-export-dialog", () => ({
  DiagnosticsExportDialog: ({
    open,
    agentId,
    agentName,
    anchorMessageId,
  }: {
    open: boolean;
    agentId: string;
    agentName: string;
    anchorMessageId?: string;
    onClose: () => void;
  }) =>
    open ? (
      <div
        role="dialog"
        aria-label="diagnostics-export"
        data-anchor-message-id={anchorMessageId ?? ""}
        data-agent-id={agentId}
        data-agent-name={agentName}
      >
        Export dialog
      </div>
    ) : null,
}));

describe("Per-message Report issue menu entry", () => {
  beforeEach(async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        id: "msg-assistant-1",
        isLast: true,
        metadata: { custom: {} },
      })
    );
  });

  it("appears in the ActionBarMore menu", async () => {
    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    render(<AssistantMessage />);

    expect(screen.getByText("Report issue to support")).toBeInTheDocument();
  });

  it("opens DiagnosticsExportDialog with the message id as anchor on click", async () => {
    const { AssistantMessage } = await import("@/components/assistant-ui/thread");
    const { AgentIdContext, AgentNameContext } = await import("@/components/chat");

    render(
      <AgentIdContext.Provider value="agt_42">
        <AgentNameContext.Provider value="Smithers">
          <AssistantMessage />
        </AgentNameContext.Provider>
      </AgentIdContext.Provider>
    );

    // Before clicking, the dialog should not be open.
    expect(screen.queryByRole("dialog", { name: "diagnostics-export" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Report issue to support"));

    const dialog = screen.getByRole("dialog", { name: "diagnostics-export" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("data-anchor-message-id", "msg-assistant-1");
    expect(dialog).toHaveAttribute("data-agent-id", "agt_42");
    expect(dialog).toHaveAttribute("data-agent-name", "Smithers");
  });
});
