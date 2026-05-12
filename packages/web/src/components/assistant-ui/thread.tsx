import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { PinchyAttachmentButton } from "@/components/assistant-ui/pinchy-attachment-button";
import { PinchyDropZone } from "@/components/assistant-ui/pinchy-drop-zone";
import { ChatErrorMessage, type ChatError } from "@/components/assistant-ui/chat-error-message";
import { AttachmentPreview } from "@/components/assistant-ui/attachment-preview";
import { ChatImage } from "@/components/assistant-ui/chat-image";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";
import {
  AlertCircle,
  ArrowDownIcon,
  ArrowUpIcon,
  BugIcon,
  CheckCircle,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileText,
  Loader2,
  MoreHorizontalIcon,
  RotateCw,
  SquareIcon,
  X,
} from "lucide-react";
import { type FC, useState, useEffect, useRef, useContext, createContext } from "react";
import {
  AgentIdContext,
  AgentNameContext,
  RetryResendContext,
  RetryContinueContext,
  ChatStatusContext,
  PendingUploadsContext,
  RemovePendingUploadContext,
  RetryPendingUploadContext,
  CanEditContext,
  IsAdminContext,
} from "@/components/chat";
import { DiagnosticsExportDialog } from "@/components/diagnostics-export-dialog";
import { Progress } from "@/components/ui/progress";
import type { PendingUpload } from "@/hooks/use-ws-runtime";
import { RetryButton } from "@/components/chat/retry-button";
import { useComposerRuntime } from "@assistant-ui/react";
import { getDraft, saveDraft } from "@/lib/draft-store";
import { useModelCapabilities } from "@/hooks/use-model-capabilities";
import { useAgentsContext } from "@/components/agents-provider";
import { requiredCapabilityForFile } from "@/lib/attachment-capability";
import { RecoveryPanel } from "@/components/recovery-panel";
import { apiPatch } from "@/lib/api-client";
import { parseUnsupportedAttachmentError } from "@/lib/chat-errors";

export type RecoveryStateSetter = (state: { files: File[]; model: string } | null) => void;

type RecoveryContextValue = {
  recoveryState: { files: File[]; model: string } | null;
  setRecoveryState: RecoveryStateSetter;
};

export const RecoveryContext = createContext<RecoveryContextValue | null>(null);

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MessageTimestamp: FC = () => {
  const timestamp = useMessage((s) => s.metadata?.custom?.timestamp as string | undefined);
  if (!timestamp) return null;
  return <span className="text-xs text-muted-foreground/60">{formatTimestamp(timestamp)}</span>;
};

const ThreadInner: FC<{ isReconcilingMessages: boolean }> = ({ isReconcilingMessages }) => {
  const [recoveryState, setRecoveryState] = useState<{
    files: File[];
    model: string;
  } | null>(null);

  return (
    <RecoveryContext.Provider value={{ recoveryState, setRecoveryState }}>
      <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4">
        {!isReconcilingMessages && (
          <>
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <ThreadWelcome />
            </AuiIf>

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />
          </>
        )}

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-3xl bg-background pb-4 md:pb-6">
          <ThreadScrollToBottom />
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </RecoveryContext.Provider>
  );
};

export const Thread: FC<{ isReconcilingMessages?: boolean }> = ({
  isReconcilingMessages = false,
}) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <ThreadInner isReconcilingMessages={isReconcilingMessages} />
    </ThreadPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

export const STARTUP_MESSAGES = [
  "Sharpening the claws...",
  "Polishing the shell...",
  "Stretching the antennae...",
  "Emerging from the deep...",
  "Checking the tide...",
  "Adjusting the pincers...",
  "Scanning the seabed...",
  "Snapping into action...",
  "Warming up...",
  "Waving hello...",
];

const ROTATION_INTERVAL_MS = 3000;

export const ThreadWelcome: FC = () => {
  const chatStatus = useContext(ChatStatusContext);
  const [messageIndex, setMessageIndex] = useState(0);
  const indexRef = useRef(0);

  const isStarting = chatStatus.kind === "starting";

  useEffect(() => {
    if (!isStarting) return;
    // Pick a random starting message on mount (avoids hydration mismatch)
    const initial = Math.floor(Math.random() * STARTUP_MESSAGES.length);
    indexRef.current = initial;
    setMessageIndex(initial);

    const timer = setInterval(() => {
      let next: number;
      do {
        next = Math.floor(Math.random() * STARTUP_MESSAGES.length);
      } while (next === indexRef.current && STARTUP_MESSAGES.length > 1);
      indexRef.current = next;
      setMessageIndex(next);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isStarting]);

  if (chatStatus.kind === "ready" || chatStatus.kind === "responding") {
    // Render nothing in the ready/responding empty-thread state. Every agent
    // has a greetingMessage at the schema level, so the server always sends
    // an opening assistant bubble — that's the welcome. A second hardcoded
    // "How can I help you today?" would be redundant and, worse, would flash
    // briefly during the React-state ↔ assistant-ui store sync window.
    return null;
  }

  if (chatStatus.kind === "payloadRejected") {
    return (
      <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
        <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
          <p className="text-sm font-medium text-muted-foreground">
            Image too large. Send a smaller file to keep chatting.
          </p>
        </div>
      </div>
    );
  }

  if (chatStatus.kind === "unavailable") {
    const { reason } = chatStatus;
    const message =
      reason === "disconnected"
        ? "Reconnecting to the agent..."
        : reason === "configuring"
          ? "Just a moment — getting things ready..."
          : "We couldn't reconnect. Please reload to continue.";

    return (
      <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
        <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            {reason === "disconnected" && (
              <div
                data-testid="loading-spinner"
                className="size-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground"
              />
            )}
            <p className="text-sm font-medium text-muted-foreground">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  // starting state: connecting or loading history
  return (
    <div
      data-testid="welcome-skeleton"
      className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col"
    >
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div
            data-testid="loading-spinner"
            className="size-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground"
          />
          <p className="text-sm font-medium text-muted-foreground">Starting agent...</p>
          <p
            data-testid="startup-message"
            className="text-xs text-muted-foreground/60 transition-opacity duration-300"
          >
            {STARTUP_MESSAGES[messageIndex]}
          </p>
        </div>
      </div>
    </div>
  );
};

const DraftPersistence: FC = () => {
  const agentId = useContext(AgentIdContext);
  const composerRuntime = useComposerRuntime({ optional: true });
  const runtimeRef = useRef(composerRuntime);

  useEffect(() => {
    runtimeRef.current = composerRuntime;
  }, [composerRuntime]);

  useEffect(() => {
    if (!agentId || !composerRuntime) return;

    const draft = getDraft(agentId);
    if (draft) {
      composerRuntime.setText(draft.text);
      draft.files.forEach((file) => composerRuntime.addAttachment(file));
    }

    return () => {
      const rt = runtimeRef.current;
      if (!rt) return;
      const state = rt.getState();
      const files = state.attachments
        .filter((a): a is typeof a & { file: File } => "file" in a && a.file instanceof File)
        .map((a) => a.file);
      saveDraft(agentId, { text: state.text, files });
    };
  }, [agentId, composerRuntime]);

  return null;
};

function UploadChip({ upload }: { upload: PendingUpload }) {
  const removePendingUpload = useContext(RemovePendingUploadContext);
  const retryPendingUpload = useContext(RetryPendingUploadContext);
  const isImage = upload.file.type.startsWith("image/");
  const previewSrc = upload.objectUrl;

  return (
    <div className="relative flex items-start gap-1.5 rounded-lg border bg-muted/40 p-1.5 text-xs w-28 shrink-0">
      <div className="flex flex-col gap-1 w-full min-w-0">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 min-w-0">
            {upload.state === "uploading" && (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
            )}
            {upload.state === "ready" && <CheckCircle className="size-3 shrink-0 text-green-600" />}
            {upload.state === "failed" && (
              <AlertCircle className="size-3 shrink-0 text-destructive" />
            )}
            <span className="truncate text-muted-foreground">{upload.file.name}</span>
          </div>
          <button
            type="button"
            aria-label="Remove upload"
            onClick={() => removePendingUpload(upload.localId)}
            className="shrink-0 rounded p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3" />
          </button>
        </div>
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewSrc}
            alt={upload.file.name}
            className="h-14 w-full rounded object-cover"
          />
        ) : (
          <div className="flex h-14 w-full items-center justify-center rounded bg-muted">
            <FileText className="size-6 text-muted-foreground" />
          </div>
        )}
        {upload.state === "uploading" && (
          <Progress
            role="progressbar"
            aria-valuenow={upload.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            value={upload.progress}
            className="h-1"
          />
        )}
        {upload.state === "failed" && (
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-destructive">{upload.error}</span>
            <button
              type="button"
              aria-label="Retry upload"
              onClick={() => retryPendingUpload(upload.localId)}
              className="shrink-0 rounded p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCw className="size-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PendingUploadChips() {
  const pendingUploads = useContext(PendingUploadsContext);

  if (pendingUploads.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-2 pt-1 pb-1">
      {pendingUploads.map((upload) => (
        <UploadChip key={upload.localId} upload={upload} />
      ))}
    </div>
  );
}

export const Composer: FC = () => {
  const recoveryCtx = useContext(RecoveryContext);
  const [localRecoveryState, setLocalRecoveryState] = useState<{
    files: File[];
    model: string;
  } | null>(null);

  // When rendered inside ThreadInner, use the shared context state so that
  // AssistantErrorOrContent can also trigger the recovery panel. When rendered
  // standalone (e.g. in tests), fall back to local state.
  const recoveryState = recoveryCtx ? recoveryCtx.recoveryState : localRecoveryState;
  const setRecoveryState: RecoveryStateSetter = recoveryCtx
    ? recoveryCtx.setRecoveryState
    : setLocalRecoveryState;

  const agentId = useContext(AgentIdContext);
  const canEditAgent = useContext(CanEditContext);
  const isAdmin = useContext(IsAdminContext);
  const { getAgent, sortedAgents } = useAgentsContext();
  const composerRuntime = useComposerRuntime({ optional: true });
  const { data: capabilities } = useModelCapabilities();

  const agent = agentId ? getAgent(agentId) : undefined;
  const agentModel = agent?.model ?? "";
  const agentName = agent?.name ?? "";

  // Agents (other than the current one) whose model satisfies the capability
  // the blocked attachment needs. Surfaces in RecoveryPanel as a fallback for
  // users who cannot edit the current agent's model (e.g. non-admins viewing
  // a shared agent).
  const recoveryCapability = recoveryState?.files[0]
    ? requiredCapabilityForFile(recoveryState.files[0].type)
    : null;
  const otherCompatibleAgents =
    recoveryCapability && capabilities
      ? sortedAgents
          .filter((a) => a.id !== agentId)
          .filter((a) => {
            const caps = capabilities[a.model];
            return caps?.[recoveryCapability] === true;
          })
          .map((a) => ({ id: a.id, name: a.name }))
      : [];

  // Inspects the current attachments and returns any files whose required
  // capability the current model doesn't support. Used by both the Send
  // button onClick path (assistant-ui's Send is type=submit but invokes
  // `send()` directly via its onClick handler, BEFORE the form submit fires;
  // intercepting onClick is the only way to stop the runtime from firing the
  // request) and the form-level onSubmit path (Enter-key).
  function getBlockedFiles(): File[] {
    const state = composerRuntime?.getState();
    const attachments = state?.attachments ?? [];
    return attachments
      .filter((a): a is typeof a & { file: File } => "file" in a && a.file instanceof File)
      .map((a) => a.file)
      .filter((file) => {
        const cap = requiredCapabilityForFile(file.type);
        if (!cap) return false;
        const modelCaps = agentModel ? capabilities?.[agentModel] : undefined;
        return modelCaps !== undefined && !modelCaps[cap];
      });
  }

  function maybeBlock(e: { preventDefault: () => void }): boolean {
    const blockedFiles = getBlockedFiles();
    if (blockedFiles.length > 0) {
      e.preventDefault();
      setRecoveryState({ files: blockedFiles, model: agentModel });
      return true;
    }
    setRecoveryState(null);
    return false;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    maybeBlock(e);
  }

  function handleSendClick(e: React.MouseEvent<HTMLButtonElement>) {
    maybeBlock(e);
  }

  // Shape flat capability map into ProviderGroup[] for ModelPicker
  const providers = (() => {
    if (!capabilities) return [];
    const groups = new Map<
      string,
      {
        id: string;
        name: string;
        models: { id: string; name: string; capabilities: (typeof capabilities)[string] }[];
      }
    >();
    for (const [qualifiedId, caps] of Object.entries(capabilities)) {
      const slashIdx = qualifiedId.indexOf("/");
      if (slashIdx === -1) continue;
      const providerId = qualifiedId.slice(0, slashIdx);
      const modelId = qualifiedId.slice(slashIdx + 1);
      if (!groups.has(providerId)) {
        groups.set(providerId, { id: providerId, name: providerId, models: [] });
      }
      groups.get(providerId)!.models.push({ id: qualifiedId, name: modelId, capabilities: caps });
    }
    return Array.from(groups.values());
  })();

  // Typing is always allowed — only the send button reflects connection
  // state. A reconnect mid-sentence must not block the user from finishing
  // their thought; submission is what's gated.
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onSubmit={handleSubmit}
    >
      <DraftPersistence />
      {recoveryState && (
        <RecoveryPanel
          filename={recoveryState.files[0]?.name ?? "attachment"}
          capability={requiredCapabilityForFile(recoveryState.files[0]?.type ?? "") ?? "vision"}
          agentName={agentName}
          agentModel={recoveryState.model}
          canEditAgent={canEditAgent}
          isAdmin={isAdmin}
          providers={providers}
          otherCompatibleAgents={otherCompatibleAgents}
          onUpdateAgent={async (newModel) => {
            if (agentId) {
              await apiPatch(`/api/agents/${agentId}`, { model: newModel });
            }
            setRecoveryState(null);
          }}
          onRemoveAttachment={() => setRecoveryState(null)}
          onDismiss={() => setRecoveryState(null)}
        />
      )}
      <PinchyDropZone className="aui-composer-attachment-dropzone flex w-full flex-col rounded-2xl border border-input bg-background px-1 pt-2 outline-none transition-shadow has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/20">
        <PendingUploadChips />
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="aui-composer-input mb-0.5 md:mb-1 max-h-32 min-h-10 md:min-h-14 w-full resize-none bg-transparent px-4 pt-2 pb-1 md:pb-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <ComposerAction onSendClick={handleSendClick} />
      </PinchyDropZone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ onSendClick?: (e: React.MouseEvent<HTMLButtonElement>) => void }> = ({
  onSendClick,
}) => {
  const chatStatus = useContext(ChatStatusContext);
  const sendAllowed = chatStatus.kind === "ready" || chatStatus.kind === "payloadRejected";

  return (
    <div className="aui-composer-action-wrapper relative mx-2 mb-1 md:mb-2 flex items-center justify-between">
      <PinchyAttachmentButton />
      {/* Send and Stop are mutually exclusive: rendering both at once
          (one disabled, the other inert) produces the dead-end UI from #207. */}
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild disabled={!sendAllowed} onClick={onSendClick}>
          <TooltipIconButton
            tooltip="Send message"
            side="bottom"
            type="submit"
            variant="default"
            size="icon"
            className="aui-composer-send size-8 rounded-full"
            aria-label="Send message"
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel size-8 rounded-full"
            aria-label="Stop generating"
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantErrorOrContent: FC<{ actionSlot?: React.ReactNode }> = ({ actionSlot }) => {
  const error = useMessage((s) => s.metadata?.custom?.error as ChatError | undefined);
  const agentId = useContext(AgentIdContext) ?? "";
  const { getAgent } = useAgentsContext();
  const recoveryCtx = useContext(RecoveryContext);
  const setRecoveryState = recoveryCtx?.setRecoveryState ?? (() => {});

  const providerError = error?.providerError;
  const unsupported = providerError ? parseUnsupportedAttachmentError(providerError) : null;

  useEffect(() => {
    if (!unsupported) return;
    const agent = agentId ? getAgent(agentId) : undefined;
    setRecoveryState({ files: [], model: agent?.model ?? "" });
  }, [unsupported, agentId, getAgent, setRecoveryState]);

  if (error && !unsupported) {
    return <ChatErrorMessage error={error} agentId={agentId} actionSlot={actionSlot} />;
  }

  if (unsupported) {
    return null;
  }

  return (
    <>
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          tools: { Fallback: ToolFallback },
        }}
      />
      <MessageError />
    </>
  );
};

const AssistantFooter: FC = () => {
  const isError = useMessage((s) => !!s.metadata?.custom?.error);

  if (isError) return null;

  return (
    <div className="aui-assistant-message-footer mt-1 ml-2 flex items-center gap-2">
      <MessageTimestamp />
      <AssistantActionBar />
    </div>
  );
};

export const AssistantMessage: FC = () => {
  const isRetryable = useMessage((s) => !!s.metadata?.custom?.retryable);
  const hasError = useMessage((s) => !!s.metadata?.custom?.error);
  const retryReason = useMessage(
    (s) =>
      (s.metadata?.custom?.retryReason as
        | "orphan"
        | "partial_stream_failure"
        | "send_failure"
        | undefined) ?? "partial_stream_failure"
  );
  const isLast = useMessage((s) => s.isLast);
  const onRetryContinue = useContext(RetryContinueContext);

  const showRetry = isRetryable && isLast;
  const retryButton = showRetry ? (
    <RetryButton onClick={() => onRetryContinue(retryReason)} />
  ) : null;

  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150"
      data-role="assistant"
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        <AssistantErrorOrContent actionSlot={hasError ? retryButton : null} />
      </div>

      {showRetry && !hasError && <div className="mt-2 flex justify-end px-2">{retryButton}</div>}

      <AssistantFooter />
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const messageId = useMessage((s) => s.id);
  const agentId = useContext(AgentIdContext) ?? "";
  const agentName = useContext(AgentNameContext) ?? "Unknown";
  const [reportIssueOpen, setReportIssueOpen] = useState(false);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-floating:absolute data-floating:rounded-md data-floating:border data-floating:bg-background data-floating:p-1 data-floating:shadow-sm"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
            data-testid="assistant-action-bar-more-trigger"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
          <ActionBarMorePrimitive.Item
            onSelect={() => setReportIssueOpen(true)}
            data-testid="report-issue-menu-item"
            className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <BugIcon className="size-4" />
            Report issue to support
          </ActionBarMorePrimitive.Item>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      <DiagnosticsExportDialog
        open={reportIssueOpen}
        agentId={agentId}
        agentName={agentName}
        anchorMessageId={messageId}
        onClose={() => setReportIssueOpen(false)}
      />
    </ActionBarPrimitive.Root>
  );
};

export function sendingOpacityClass(status: string | undefined): string {
  return status === "sending" ? "opacity-60" : "";
}

// Re-exported as FilePart for backward compatibility and stable test imports.
export { AttachmentPreview as FilePart };

export const UserMessage: FC = () => {
  const status = useMessage((s) => s.metadata?.custom?.status as string | undefined);
  const isLast = useMessage((s) => s.isLast);
  const messageId = useMessage((s) => s.id);
  const onRetryResend = useContext(RetryResendContext);

  const isFailed = status === "failed";

  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-(--thread-max-width) animate-in flex-col items-end gap-1 px-2 py-3 duration-150"
      data-role="user"
    >
      <UserMessageAttachments />

      <div
        className={cn(
          "aui-user-message-content-wrapper min-w-0 max-w-[85%]",
          sendingOpacityClass(status)
        )}
      >
        <div className="aui-user-message-content wrap-break-word rounded-2xl bg-muted px-4 py-2.5 text-foreground">
          <MessagePrimitive.Parts
            components={{
              Image: ChatImage,
              File: AttachmentPreview,
            }}
          />
        </div>
      </div>

      {isFailed && isLast && (
        <div className="flex items-center gap-2 text-sm text-destructive mr-1 mt-0.5">
          <span>Couldn&apos;t deliver</span>
          <RetryButton onClick={() => onRetryResend(messageId)} />
        </div>
      )}

      <div className="flex mr-1">
        <MessageTimestamp />
      </div>
    </MessagePrimitive.Root>
  );
};
