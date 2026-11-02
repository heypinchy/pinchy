"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";
import { FULL_VIEW_KEYS, displayScalar, splitTruncation } from "@/lib/approvals/display";

/** Texts longer than this show a preview first, with the full text on demand. */
const PREVIEW_LEN = 200;

/**
 * A string value as the summary stored it: whitespace kept (`pre-wrap`), a
 * string that would read as a literal shown quoted (`displayScalar`), and a
 * long text previewed — unless `full`, for the fields that say who an action
 * reaches or where it lands, which are short and are the decision.
 *
 * The truncation marker the summary appends to a value it cut is shown
 * OUTSIDE the preview: inside it, it sat in exactly the part the preview
 * collapses (second review of #1242).
 */
function TextValue({ text, full }: { text: string; full: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const split = splitTruncation(text);
  const shown = displayScalar(split.text);
  const marker = split.marker ? (
    <span className="text-muted-foreground"> {split.marker}</span>
  ) : null;
  if (full || shown.length <= PREVIEW_LEN) {
    return (
      <span className="break-words">
        <span className="whitespace-pre-wrap">{shown}</span>
        {marker}
      </span>
    );
  }
  return (
    <span className="break-words">
      <span className="whitespace-pre-wrap">
        {expanded ? shown : `${shown.slice(0, PREVIEW_LEN)}…`}
      </span>
      {!expanded && (
        <span className="text-muted-foreground">
          {" "}
          ({shown.length - PREVIEW_LEN} more characters hidden)
        </span>
      )}
      {marker}{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 align-baseline text-xs"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? "Show less" : "Show full text"}
      </Button>
    </span>
  );
}

/**
 * Renders the tool's arguments as the stored summary holds them: every value,
 * arrays one entry per line, objects as labelled fields. Nothing is collapsed
 * to a count — the person approving has to see what will run. Non-string
 * values print as their literal (`false`, `1`, `null`), so a string "false"
 * (shown `"false"`) cannot pass for the boolean.
 */
function ArgValue({ value, full }: { value: unknown; full: boolean }) {
  if (typeof value === "string") return <TextValue text={value} full={full} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">(none)</span>;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <ArgValue value={item} full={full} />
          </li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return <ArgFields fields={value as Record<string, unknown>} full={full} />;
  }
  return <span className="font-mono">{displayScalar(value)}</span>;
}

function ArgFields({ fields, full }: { fields: Record<string, unknown>; full: boolean }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <span className="text-muted-foreground">(none)</span>;
  return (
    <dl className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
          <dd className="ml-3">
            <ArgValue value={value} full={full || FULL_VIEW_KEYS.has(key)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One pending confirmation, rendered the same whether it sits in the thread
 * that raised it or in the corner (#1132). Only the container differs. */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (approval: PendingApproval, decision: "approve" | "deny") => void;
}) {
  const hasArgs = approval.argsSummary && Object.keys(approval.argsSummary).length > 0;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-lg">
      <p className="text-sm font-medium">{approval.agentName} needs your confirmation</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Run <span className="font-mono">{approval.toolName}</span>
        {hasArgs ? " with:" : "?"}
      </p>
      {hasArgs ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted/50 p-2 text-sm">
          <ArgFields fields={approval.argsSummary as Record<string, unknown>} full={false} />
        </div>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide(approval, "deny")}
        >
          Deny
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDecide(approval, "approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}
