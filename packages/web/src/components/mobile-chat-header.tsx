import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { ChatSwitcher } from "@/components/chat-switcher";
import { AiDisclosureLabel } from "@/components/ai-disclosure-label";
import { KnowledgeSearchSheet } from "@/components/knowledge-search-sheet";

interface MobileChatHeaderProps {
  agentId: string;
  agentName: string;
  /** Active chat from the URL, or null for the default/legacy chat (#508). */
  chatId?: string | null;
  avatarUrl?: string;
  canEdit?: boolean;
  /** Offer "What can this agent search?" (#1386). */
  searchesKnowledge?: boolean;
}

export function MobileChatHeader({
  agentId,
  agentName,
  chatId = null,
  avatarUrl,
  canEdit = false,
  searchesKnowledge = false,
}: MobileChatHeaderProps) {
  return (
    <header className="md:hidden shrink-0 flex items-center justify-between p-3 border-b">
      <Link href="/agents" aria-label="Back" className="p-1">
        <ArrowLeft className="size-5" />
      </Link>

      <div className="flex items-center gap-2 min-w-0 flex-1 justify-center">
        {avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={agentName} className="size-8 rounded-full shrink-0" />
        )}
        <ChatSwitcher agentId={agentId} chatId={chatId} agentName={agentName} />
        <AiDisclosureLabel />
      </div>

      <div className="flex items-center shrink-0">
        {searchesKnowledge && <KnowledgeSearchSheet agentId={agentId} className="p-1" />}
        {canEdit ? (
          <Link href={`/chat/${agentId}/settings`} aria-label="Settings" className="p-1">
            <Settings className="size-5" />
          </Link>
        ) : (
          !searchesKnowledge && <div className="p-1 size-7" />
        )}
      </div>
    </header>
  );
}
