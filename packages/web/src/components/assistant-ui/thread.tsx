import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { ChatImage } from "@/components/assistant-ui/chat-image";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
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
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { type FC, useState, useEffect, useRef, useContext } from "react";
import { AgentAvatarContext, AgentIdContext } from "@/components/chat";
import { useComposerRuntime } from "@assistant-ui/react";
import { getDraft, saveDraft } from "@/lib/draft-store";

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

export const Thread: FC<{ isHistoryLoaded?: boolean }> = ({ isHistoryLoaded = false }) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <ThreadWelcome isHistoryLoaded={isHistoryLoaded} />
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-3xl bg-background pb-4 md:pb-6">
          <ThreadScrollToBottom />
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
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

const ThreadWelcome: FC<{ isHistoryLoaded?: boolean }> = ({ isHistoryLoaded = false }) => {
  const avatarUrl = useContext(AgentAvatarContext);
  const [messageIndex, setMessageIndex] = useState(0);
  const indexRef = useRef(0);

  useEffect(() => {
    if (isHistoryLoaded) return;
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
  }, [isHistoryLoaded]);

  if (isHistoryLoaded) {
    // Ready state: agent is loaded, waiting for user input
    return (
      <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
        <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            {avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="size-12 rounded-full" />
            )}
            <p className="text-sm font-medium text-muted-foreground">How can I help you?</p>
          </div>
        </div>
      </div>
    );
  }

  // Loading state: connecting or loading history
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div
            data-testid="loading-spinner"
            className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground"
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

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <DraftPersistence />
      <ComposerPrimitive.AttachmentDropzone className="aui-composer-attachment-dropzone flex w-full flex-col rounded-2xl border border-input bg-background px-1 pt-2 outline-none transition-shadow has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50">
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="aui-composer-input mb-1 max-h-32 min-h-14 w-full resize-none bg-transparent px-4 pt-2 pb-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <ComposerAction />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative mx-2 mb-2 flex items-center justify-between">
      <ComposerAddAttachment />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
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

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150"
      data-role="assistant"
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools: { Fallback: ToolFallback },
          }}
        />
        <MessageError />
      </div>

      <div className="aui-assistant-message-footer mt-1 ml-2 flex items-center gap-2">
        <MessageTimestamp />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
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
          <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
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
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-(--thread-max-width) animate-in flex-col items-end gap-1 px-2 py-3 duration-150"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper min-w-0 max-w-[85%]">
        <div className="aui-user-message-content wrap-break-word rounded-2xl bg-muted px-4 py-2.5 text-foreground">
          <MessagePrimitive.Parts
            components={{
              Image: ChatImage,
            }}
          />
        </div>
      </div>

      <div className="flex mr-1">
        <MessageTimestamp />
      </div>
    </MessagePrimitive.Root>
  );
};
