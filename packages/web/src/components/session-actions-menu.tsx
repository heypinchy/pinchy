"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { apiPost, ApiError } from "@/lib/api-client";
import type { CompactSessionRequest } from "@/lib/schemas/sessions";

/**
 * Overflow menu in the chat header for actions on the current conversation.
 * Today it holds a single action — "Compact conversation" — which asks
 * OpenClaw to summarize the in-context transcript so a long chat stops
 * degrading model quality. Compaction takes effect on the next message and we
 * deliberately do NOT reload history, so the user's visible messages don't
 * vanish from under them.
 */
export function SessionActionsMenu({ agentId }: { agentId: string }) {
  const [isCompacting, setIsCompacting] = useState(false);

  async function handleCompact() {
    setIsCompacting(true);
    try {
      await apiPost<{ ok: boolean }, CompactSessionRequest>(
        `/api/agents/${agentId}/sessions/compact`,
        {}
      );
      toast.success("Conversation compacted. It takes effect on your next message.");
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : "Couldn't compact the conversation. Please try again."
      );
    } finally {
      setIsCompacting(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Conversation actions"
          className="text-muted-foreground hover:text-foreground size-7"
        >
          <MoreHorizontal className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={handleCompact} disabled={isCompacting}>
          Compact conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
