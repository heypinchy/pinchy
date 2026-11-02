"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";

/** Texts longer than this show a preview first, with the full text on demand. */
const PREVIEW_LEN = 200;

function LongText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= PREVIEW_LEN) {
    return <span className="break-words">{text}</span>;
  }
  return (
    <span className="break-words">
      {expanded ? text : `${text.slice(0, PREVIEW_LEN)}…`}
      {!expanded && (
        <span className="text-muted-foreground">
          {" "}
          ({text.length - PREVIEW_LEN} more characters hidden)
        </span>
      )}{" "}
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
 * to a count — the person approving has to see what will run.
 */
function ArgValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <LongText text={value} />;
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">(empty)</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">(none)</span>;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <ArgValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return <ArgFields fields={value as Record<string, unknown>} />;
  }
  return <span>{String(value)}</span>;
}

function ArgFields({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <span className="text-muted-foreground">(none)</span>;
  return (
    <dl className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
          <dd className="ml-3">
            <ArgValue value={value} />
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
          <ArgFields fields={approval.argsSummary as Record<string, unknown>} />
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
