"use client";

import { useState } from "react";
import { FolderSearch } from "lucide-react";

import { KnowledgeFolderTree } from "@/components/knowledge-folder-tree";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const TITLE = "What can this agent search?";

/**
 * The chat-side, read-only view of a knowledge-base agent's folders (#1386).
 * For everyone who can chat with the agent — "why doesn't it know about X?"
 * is a member's question first, and the settings page is not theirs to open.
 *
 * The tree mounts only while the sheet is open: it polls during a run, and a
 * chat page should not do that for a view nobody is looking at.
 */
export function KnowledgeSearchSheet({
  agentId,
  className = "text-muted-foreground hover:text-foreground transition-colors",
}: {
  agentId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button" aria-label={TITLE} title={TITLE} className={className}>
          <FolderSearch className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{TITLE}</SheetTitle>
          <SheetDescription>
            The folders this agent answers from, and how much of each it can search right now. Files
            that aren&apos;t searchable yet won&apos;t show up in its answers.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {open && <KnowledgeFolderTree agentId={agentId} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
