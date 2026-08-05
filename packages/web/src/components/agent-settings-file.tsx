"use client";

import { useState, useEffect, useRef } from "react";
import { appendInstructionDraft } from "@/lib/instruction-handoff";
import { MarkdownEditor } from "@/components/markdown-editor";
import { DocsLink } from "@/components/docs-link";

type Filename = "SOUL.md" | "AGENTS.md";

function explanationFor(filename: Filename): string {
  switch (filename) {
    case "SOUL.md":
      return "This is your agent's personality and identity. Describe who the agent is, how it should behave, and what values it represents. The agent reads this file at the start of every conversation.";
    case "AGENTS.md":
      return "These are your agent's operating instructions — what it should do, how it should handle tasks, and any domain-specific rules. Think of it as the agent's job description.";
  }
}

interface AgentSettingsFileProps {
  agentId: string;
  filename: Filename;
  content: string;
  /**
   * A draft carried over from chat by "Save as instruction" (#1144), appended
   * to the editor's text but deliberately NOT to the saved baseline: the tab
   * has to open dirty, or the user's Save would have nothing to write.
   */
  appendDraft?: string;
  onChange: (content: string, isDirty: boolean) => void;
}

export function AgentSettingsFile({
  agentId: _agentId,
  filename,
  content: initialContent,
  appendDraft,
  onChange,
}: AgentSettingsFileProps) {
  const [content, setContent] = useState(() =>
    appendDraft ? appendInstructionDraft(initialContent, appendDraft) : initialContent
  );
  // The baseline is what is SAVED, never what was carried over. Folding the
  // draft in here would make the appended text look like it had always been
  // there, and the save would be skipped as a no-op.
  const initialRef = useRef(initialContent);

  // Notify parent on mount — dirty exactly when a draft was carried in. The
  // empty dep list closes over the first render's `content`, which is the
  // state the initialiser above produced.
  useEffect(() => {
    onChange(content, content !== initialRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChange(newContent: string) {
    setContent(newContent);
    onChange(newContent, newContent !== initialRef.current);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {explanationFor(filename)}
        {filename === "AGENTS.md" && (
          <>
            {" "}
            <DocsLink
              path="explanation/instructions-vs-memory"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Instructions vs. Memory
            </DocsLink>
          </>
        )}
      </p>
      <MarkdownEditor value={content} onChange={handleChange} />
    </div>
  );
}
