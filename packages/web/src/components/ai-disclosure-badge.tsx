import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Persistent AI disclosure in the chat header (EU AI Act Article 50 — users
 * must be informed when they interact with an AI system). A small "AI
 * assistant" badge next to the agent name makes the disclosure visible on
 * every interaction without a modal or per-session system message. #115
 *
 * The disclosure is non-configurable in v1: every Pinchy agent is an AI
 * assistant, so the label is always honest. A future admin-configurable
 * custom disclosure text can replace the body without changing the call site.
 */
export function AiDisclosureBadge() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="text-xs font-normal shrink-0 gap-1"
            data-testid="ai-disclosure-badge"
          >
            <Bot className="size-3" aria-hidden="true" />
            AI assistant
          </Badge>
        </TooltipTrigger>
        <TooltipContent>You are chatting with an AI assistant.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
