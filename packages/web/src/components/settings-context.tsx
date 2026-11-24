"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { apiPut, errorMessage, extractFieldErrors } from "@/lib/api-client";
import { CONTEXT_CONTENT_MAX_LENGTH, type ContextContentInput } from "@/lib/schemas/context";

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
 * failed"` and the actionable text in `details.fieldErrors` — here that is the
 * "Context is too long" message. `ApiError.message` is built from `error` and
 * `message` only, so `errorMessage()` alone would show "Validation failed" and
 * leave the user with nothing to correct.
 *
 * This form has ONE field, so the field error is the message rather than an
 * inline annotation — which is why it reads `extractFieldErrors` (the shared
 * unwrapper #1087 consolidated) instead of growing a third private copy of it.
 */
function readErrorMessage(e: unknown): string {
  const fieldError = Object.values(extractFieldErrors(e) ?? {}).find(
    (message) => message.length > 0
  );
  return fieldError ?? errorMessage(e, "Failed to save");
}

interface SettingsContextProps {
  /** `null` until the context has loaded. */
  userContext: string | null;
  orgContext: string | null;
  /** The load failed, so there is no stored context to edit. */
  userContextFailed?: boolean;
  orgContextFailed?: boolean;
  isAdmin: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
}

interface ContextSectionProps {
  title: string;
  explanation: string;
  apiUrl: string;
  onDirtyChange?: (isDirty: boolean) => void;
}

/**
 * The editor appears only once its context has loaded. An editor shown before
 * that, or after a failed load, starts empty, and its Save replaces the stored
 * context with that emptiness.
 */
function ContextSection({
  initialContent,
  loadFailed,
  ...props
}: ContextSectionProps & { initialContent: string | null; loadFailed?: boolean }) {
  if (initialContent !== null && !loadFailed) {
    return <ContextEditor {...props} initialContent={initialContent} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{props.explanation}</p>
        {loadFailed ? (
          <p role="alert" className="text-sm text-red-600">
            We couldn&apos;t load this context, so we&apos;re not showing the editor: saving it
            empty would replace what&apos;s stored. Reload the page to try again.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
      </CardContent>
    </Card>
  );
}

function ContextEditor({
  title,
  explanation,
  initialContent,
  apiUrl,
  onDirtyChange,
}: ContextSectionProps & { initialContent: string }) {
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
      await apiPut<unknown, ContextContentInput>(apiUrl, { content });

      setSavedContent(content);
      setFeedback({
        type: "success",
        message: "Saved. Changes will apply to your next conversation.",
      });
    } catch (e) {
      setFeedback({ type: "error", message: readErrorMessage(e) });
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
          label={title}
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
  userContextFailed,
  orgContextFailed,
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
        loadFailed={userContextFailed}
        apiUrl="/api/users/me/context"
        onDirtyChange={setUserSectionDirty}
      />

      {isAdmin && (
        <ContextSection
          title="Organization Context"
          explanation="This is context about your organization — team structure, conventions, and domain knowledge. It's applied to all shared agents."
          initialContent={orgContext}
          loadFailed={orgContextFailed}
          apiUrl="/api/settings/context"
          onDirtyChange={setOrgSectionDirty}
        />
      )}
    </div>
  );
}
