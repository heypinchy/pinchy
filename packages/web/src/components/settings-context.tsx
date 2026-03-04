"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/markdown-editor";

interface SettingsContextProps {
  userContext: string;
  orgContext: string;
  isAdmin: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
}

function ContextSection({
  title,
  explanation,
  initialContent,
  apiUrl,
  onDirtyChange,
}: {
  title: string;
  explanation: string;
  initialContent: string;
  apiUrl: string;
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    onDirtyChange?.(content !== savedContent);
  }, [content, savedContent, onDirtyChange]);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch(apiUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const data = await res.json();
        setFeedback({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }

      setSavedContent(content);
      setFeedback({
        type: "success",
        message: "Saved. Changes will apply to your next conversation.",
      });
    } catch {
      setFeedback({ type: "error", message: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{explanation}</p>

        <MarkdownEditor
          value={content}
          onChange={(v) => {
            setContent(v);
            setFeedback(null);
          }}
        />

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
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
      </CardContent>
    </Card>
  );
}

export function SettingsContext({
  userContext,
  orgContext,
  isAdmin,
  onDirtyChange,
}: SettingsContextProps) {
  const [userSectionDirty, setUserSectionDirty] = useState(false);
  const [orgSectionDirty, setOrgSectionDirty] = useState(false);

  useEffect(() => {
    onDirtyChange?.(userSectionDirty || orgSectionDirty);
  }, [userSectionDirty, orgSectionDirty, onDirtyChange]);

  return (
    <div className="space-y-6">
      <ContextSection
        title="Your Context"
        explanation="This is context about you — your role, preferences, and how you work. It's applied to your personal assistant."
        initialContent={userContext}
        apiUrl="/api/users/me/context"
        onDirtyChange={setUserSectionDirty}
      />

      {isAdmin && (
        <ContextSection
          title="Organization Context"
          explanation="This is context about your organization — team structure, conventions, and domain knowledge. It's applied to all shared agents."
          initialContent={orgContext}
          apiUrl="/api/settings/context"
          onDirtyChange={setOrgSectionDirty}
        />
      )}
    </div>
  );
}
