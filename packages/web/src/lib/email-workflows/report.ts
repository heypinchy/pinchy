import { z } from "zod";

import type { ProcessedEmailOutcome } from "@/lib/email-workflows/types";

/**
 * The inbox run's result contract (#139): the agent must end its reply with
 * one fenced JSON block matching this schema. This module is the pure
 * extractor/validator; the OpenClaw run adapter feeds a failure back to the
 * model as a single correction turn before failing the run.
 *
 * Design note: OpenClaw does not stream `tool_use` args through `chat()` (the
 * declared chunk type exists but real Gateways never emit it), so a report
 * *tool* would be invisible to the adapter. The final assistant text is the
 * native result channel — hence a JSON block, not a tool call.
 */

const TITLE_MAX = 200;
const CONTENT_MAX = 8000;

const outcomeSchema = z.object({
  odooModel: z.string().optional(),
  odooId: z.number().int().optional(),
  link: z.string().optional(),
  note: z.string().optional(),
});

const reportSchema = z.object({
  status: z.enum(["done", "no_action"]),
  // A runaway model reply must not fail the run — truncate, don't reject.
  // Emptiness after trimming DOES reject: a blank feed entry is useless noise.
  title: z
    .string()
    .trim()
    .min(1, "title must not be empty")
    .transform((s) => s.slice(0, TITLE_MAX)),
  content: z
    .string()
    .trim()
    .min(1, "content must not be empty")
    .transform((s) => s.slice(0, CONTENT_MAX)),
  outcome: outcomeSchema.optional(),
});

export interface InboxReport {
  status: "done" | "no_action";
  title: string;
  content: string;
  outcome?: ProcessedEmailOutcome;
}

export type ParseInboxReportResult =
  { ok: true; report: InboxReport } | { ok: false; error: string };

/**
 * Extract and validate the report from a run's final assistant text.
 *
 * Deterministic extraction rule: the LAST fenced code block wins (models often
 * think out loud in earlier blocks); if the text has no fence at all, the whole
 * trimmed text is tried as bare JSON — that is exactly the shape a correction
 * turn ("reply with only the JSON") produces. Never throws: the error string is
 * written to be shown to the model, so it names the offending field.
 */
export function parseInboxReport(text: string): ParseInboxReportResult {
  const raw = extractCandidate(text);
  if (raw === null) {
    return { ok: false, error: "No JSON found: end your reply with one fenced ```json block." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `The report block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = reportSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `The report does not match the schema — ${issues}` };
  }

  return { ok: true, report: result.data };
}

/** The last fenced block's body, or the whole text if it looks like bare JSON. */
function extractCandidate(text: string): string | null {
  const fences = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)];
  if (fences.length > 0) {
    return fences[fences.length - 1][1];
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  return null;
}
