"use client";

import { useState, useEffect, useRef } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";

const EXPLANATIONS: Record<string, string> = {
  "SOUL.md":
    "This is your agent's personality and identity. Describe who the agent is, how it should behave, and what values it represents. The agent reads this file at the start of every conversation.",
  "AGENTS.md":
    "These are your agent's operating instructions — what it should do, how it should handle tasks, and any domain-specific rules. Think of it as the agent's job description.",
};

interface AgentSettingsFileProps {
  agentId: string;
  filename: "SOUL.md" | "AGENTS.md";
  content: string;
  onChange: (content: string, isDirty: boolean) => void;
}

export function AgentSettingsFile({
  agentId: _agentId,
  filename,
  content: initialContent,
  onChange,
}: AgentSettingsFileProps) {
  const [content, setContent] = useState(initialContent);
  const initialRef = useRef(initialContent);

  // Notify parent on mount with isDirty=false
  useEffect(() => {
    onChange(initialRef.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChange(newContent: string) {
    setContent(newContent);
    onChange(newContent, newContent !== initialRef.current);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{EXPLANATIONS[filename]}</p>
      <MarkdownEditor value={content} onChange={handleChange} />
    </div>
  );
}
