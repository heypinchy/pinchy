"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
}

export function AgentSettingsFile({
  agentId,
  filename,
  content: initialContent,
}: AgentSettingsFileProps) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/agents/${agentId}/files/${filename}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const data = await res.json();
        setFeedback({
          type: "error",
          message: data.error || "Failed to save file",
        });
        return;
      }

      setFeedback({
        type: "success",
        message: "Saved. Changes will apply to your next conversation.",
      });
    } catch {
      setFeedback({ type: "error", message: "Failed to save file" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{EXPLANATIONS[filename]}</p>

      <MarkdownEditor
        value={content}
        onChange={(v) => {
          setContent(v);
          setFeedback(null);
        }}
      />

      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save & restart"}
      </Button>

      {feedback && (
        <p
          className={
            feedback.type === "success" ? "text-sm text-green-600" : "text-sm text-red-600"
          }
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}
