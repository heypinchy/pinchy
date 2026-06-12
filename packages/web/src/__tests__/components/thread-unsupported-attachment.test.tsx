import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockUseMessage = vi.fn();
const mockGetAgent = vi.fn();

vi.mock("@assistant-ui/react", () => ({
  ThreadPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Viewport: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Messages: () => null,
    ViewportFooter: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    ScrollToBottom: ({ children }: any) => <div>{children}</div>,
  },
  AuiIf: ({ children }: any) => <>{children}</>,
  ComposerPrimitive: {
    Root: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    AttachmentDropzone: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Input: (props: any) => <input {...props} />,
    Send: ({ children }: any) => <div>{children}</div>,
    Cancel: ({ children }: any) => <div>{children}</div>,
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
  useMessage: (selector: (s: any) => any) =>
    selector({
      metadata: { custom: { error: mockUseMessage() } },
      isLast: true,
      id: "msg-1",
    }),
  useComposerRuntime: () => null,
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  ComposerAddAttachment: () => null,
  ComposerAttachments: () => null,
  UserMessageAttachments: () => null,
}));

vi.mock("@/components/assistant-ui/attachment-preview", () => ({
  AttachmentPreview: () => null,
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

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/report-issue-link", () => ({
  ReportIssueLink: () => null,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/chat/retry-button", () => ({
  RetryButton: ({ onClick }: any) => <button onClick={onClick}>Retry</button>,
}));

vi.mock("@/lib/draft-store", () => ({
  getDraft: () => null,
  saveDraft: () => undefined,
}));

vi.mock("@/hooks/use-model-capabilities", () => ({
  useModelCapabilities: () => ({ data: undefined }),
}));

vi.mock("@/components/agents-provider", () => ({
  useAgentsContext: () => ({ getAgent: mockGetAgent }),
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
    RetryResendContext: React.createContext<(messageId: string) => void>(() => {}),
    RetryContinueContext: React.createContext<() => void>(() => {}),
    ChatStatusContext: React.createContext<{ kind: string }>({ kind: "ready" }),
    CanEditContext: React.createContext<boolean>(false),
    IsAdminContext: React.createContext<boolean>(false),
  };
});

vi.mock("@/components/recovery-panel", () => ({
  RecoveryPanel: ({ capability }: any) => (
    <div data-testid="recovery-panel" data-capability={capability} />
  ),
}));

vi.mock("@/lib/api-client", () => ({
  apiPatch: vi.fn().mockResolvedValue({}),
}));

import { AssistantMessage, RecoveryContext } from "@/components/assistant-ui/thread";
import {
  AgentIdContext,
  ChatStatusContext,
  CanEditContext,
  IsAdminContext,
} from "@/components/chat";

function renderAssistantMessage(setRecovery: ReturnType<typeof vi.fn>) {
  return render(
    <RecoveryContext.Provider value={{ recoveryState: null, setRecoveryState: setRecovery }}>
      <ChatStatusContext.Provider value={{ kind: "ready" }}>
        <AgentIdContext.Provider value="agent-123">
          <CanEditContext.Provider value={false}>
            <IsAdminContext.Provider value={false}>
              <AssistantMessage />
            </IsAdminContext.Provider>
          </CanEditContext.Provider>
        </AgentIdContext.Provider>
      </ChatStatusContext.Provider>
    </RecoveryContext.Provider>
  );
}

describe("AssistantMessage — UnsupportedAttachmentError routing", () => {
  it("calls setRecoveryState and renders no generic error bubble when providerError contains image inputs message", async () => {
    mockGetAgent.mockReturnValue({ model: "anthropic/claude-3-haiku", name: "Smithers" });
    mockUseMessage.mockReturnValue({
      providerError: "this model does not accept image inputs",
      agentName: "Smithers",
    });

    const setRecovery = vi.fn();
    renderAssistantMessage(setRecovery);

    await act(async () => {});

    expect(setRecovery).toHaveBeenCalledWith({
      files: [],
      model: "anthropic/claude-3-haiku",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a generic error bubble for document-input provider errors — Pinchy never sends native document inputs, so no recovery flow applies", async () => {
    mockGetAgent.mockReturnValue({ model: "openai/gpt-4o-mini", name: "Smithers" });
    mockUseMessage.mockReturnValue({
      providerError: "this model does not accept document inputs",
      agentName: "Smithers",
    });

    const setRecovery = vi.fn();
    renderAssistantMessage(setRecovery);

    await act(async () => {});

    expect(setRecovery).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders generic error bubble for unrelated provider errors", async () => {
    mockUseMessage.mockReturnValue({
      providerError: "Your credit balance is too low.",
      agentName: "Smithers",
    });

    const setRecovery = vi.fn();
    renderAssistantMessage(setRecovery);

    await act(async () => {});

    expect(setRecovery).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
