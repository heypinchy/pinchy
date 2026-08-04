"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { CONTEXT_CONTENT_MAX_LENGTH } from "@/lib/schemas/context";

/**
 * Below this the counter stays hidden — a limit nobody is near is noise. From
 * here on it is the only thing that makes the disabled Save button explain
 * itself, including for a context that was already over the limit when the cap
 * landed.
 */
const COUNTER_VISIBLE_FROM = Math.floor(CONTEXT_CONTENT_MAX_LENGTH * 0.9);

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * `parseRequestBody` answers a failed validation with `error: "Validation
 * failed"` and the actionable text in `details.fieldErrors`. Showing `error`
 * alone leaves the user with nothing to correct, so prefer the field error.
 */
function readErrorMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const { details, error } = data as {
      details?: { fieldErrors?: Record<string, string[] | undefined> };
      error?: unknown;
    };

    const fieldError = Object.values(details?.fieldErrors ?? {})
      .flat()
      .find((message): message is string => typeof message === "string" && message.length > 0);
    if (fieldError) return fieldError;

    if (typeof error === "string" && error.length > 0) return error;
  }

  return "Failed to save";
}

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

  // Sync local state when prop changes — uses React-recommended
  // "adjust state during render" pattern instead of useEffect.
  const [prevInitialContent, setPrevInitialContent] = useState(initialContent);
  if (prevInitialContent !== initialContent) {
    setPrevInitialContent(initialContent);
    setContent(initialContent);
    setSavedContent(initialContent);
  }

  useEffect(() => {
    onDirtyChange?.(content !== savedContent);
  }, [content, savedContent, onDirtyChange]);

  const isOverLimit = content.length > CONTEXT_CONTENT_MAX_LENGTH;

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
          message: readErrorMessage(data),
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

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving || isOverLimit}>
            {saving ? "Saving..." : "Save"}
          </Button>

          {content.length >= COUNTER_VISIBLE_FROM && (
            <span
              className={isOverLimit ? "text-sm text-red-600" : "text-sm text-muted-foreground"}
            >
              {formatCount(content.length)} / {formatCount(CONTEXT_CONTENT_MAX_LENGTH)} characters
              {isOverLimit && " — trim it to save."}
            </span>
          )}
        </div>

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
