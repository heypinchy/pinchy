import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";

interface MobileChatHeaderProps {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  canEdit?: boolean;
}

export function MobileChatHeader({
  agentId,
  agentName,
  avatarUrl,
  canEdit = false,
}: MobileChatHeaderProps) {
  return (
    <header className="md:hidden flex items-center justify-between p-3 border-b">
      <Link href="/agents" aria-label="Back" className="p-1">
        <ArrowLeft className="size-5" />
      </Link>

      <div className="flex items-center gap-2 min-w-0 flex-1 justify-center">
        {avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={agentName} className="size-6 rounded-full shrink-0" />
        )}
        <span className="font-bold truncate">{agentName}</span>
      </div>

      {canEdit ? (
        <Link href={`/chat/${agentId}/settings`} aria-label="Settings" className="p-1">
          <Settings className="size-5" />
        </Link>
      ) : (
        <div className="p-1 size-7" />
      )}
    </header>
  );
}
