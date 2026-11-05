"use client";

import { type FC, useContext, useState } from "react";
import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { Info } from "lucide-react";
import { AgentIdContext, ChatStatusContext } from "@/components/chat";
import { useAgentsContext } from "@/components/agents-provider";
import { normalizeStarterPrompts } from "@/lib/schemas/starter-prompts";

/** Remembered per browser: the shared-memory note is shown once, not per chat. */
export const SHARED_MEMORY_NOTICE_STORAGE_KEY = "pinchy.sharedMemoryNotice.dismissed";

function readNoticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(SHARED_MEMORY_NOTICE_STORAGE_KEY) !== null;
  } catch {
    // Private window or blocked storage: show the note rather than hide it.
    return false;
  }
}

function writeNoticeDismissed(): void {
  try {
    window.localStorage.setItem(SHARED_MEMORY_NOTICE_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Nothing to persist to; it is dismissed for this page view only.
  }
}

/**
 * The chips for an agent's starter prompts (#570). Renders nothing when none
 * are configured. Normalized so `key={prompt}` never collides, including for
 * rows that predate save-side dedup.
 */
export const StarterPromptChips: FC<{ prompts: string[] }> = ({ prompts }) => {
  const starterPrompts = normalizeStarterPrompts(prompts);
  if (starterPrompts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-4">
      {starterPrompts.map((prompt) => (
        <ThreadPrimitive.Suggestion
          key={prompt}
          prompt={prompt}
          send
          className="max-w-full rounded-2xl border px-4 py-1.5 text-sm break-words text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {prompt}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
};

const SharedMemoryNotice: FC = () => {
  const [dismissed, setDismissed] = useState(readNoticeDismissed);
  if (dismissed) return null;
  return (
    <p className="mx-auto flex max-w-md items-start gap-2 px-4 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        This agent is shared with your team. What you tell it can become part of what it remembers
        when helping your colleagues.{" "}
        <button
          type="button"
          onClick={() => {
            writeNoticeDismissed();
            setDismissed(true);
          }}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Got it
        </button>
      </span>
    </p>
  );
};

const NewConversationContent: FC = () => {
  const chatStatus = useContext(ChatStatusContext);
  const agentId = useContext(AgentIdContext);
  const { getAgent } = useAgentsContext();
  const agent = agentId ? getAgent(agentId) : undefined;

  if (chatStatus.kind !== "ready" || !agent) return null;

  // Memory is a permission (Agent Settings → Permissions → Memory). Without
  // it nothing a member says is kept, so the note would state something false.
  const sharesMemory = !agent.isPersonal && (agent.allowedTools ?? []).includes("pinchy_memory");

  return (
    <div className="mx-auto mt-2 mb-4 flex w-full max-w-(--thread-max-width) flex-col items-center gap-3">
      <StarterPromptChips prompts={agent.starterPrompts ?? []} />
      {sharesMemory && <SharedMemoryNotice />}
    </div>
  );
};

/**
 * What a new conversation offers below the agent's greeting, until the user
 * has written their first message (#1275).
 *
 * Gated on "no user message yet" rather than `thread.isEmpty`: the server
 * opens every new conversation with the greeting as an assistant message, so
 * the thread is never empty once the chat is ready. The starter prompts used
 * to sit behind `isEmpty` and therefore never rendered. An empty thread is
 * still ThreadWelcome's to handle.
 */
export const NewConversationPrompts: FC = () => (
  <AuiIf
    condition={(s) =>
      s.thread.messages.length > 0 && s.thread.messages.every((m) => m.role !== "user")
    }
  >
    <NewConversationContent />
  </AuiIf>
);
