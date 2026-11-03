import { approvalPromptFor, type ApprovalPrompt } from "@/lib/approvals/prompt";
import { summarizeCall, type SummarizeOptions, type SummaryLimit } from "@/lib/approvals/summary";

/** The stored summary alone, for tests that assert on what the card draws. */
export function summarizeArgs(
  params: unknown,
  options: SummarizeOptions = {}
): Record<string, unknown> {
  return summarizeCall(params, options).summary;
}

/**
 * The prompt for raw `params`, summarized the way the gate summarizes them
 * (`summarizeCall`, then `approvalPromptFor`).
 */
export function buildApprovalPrompt(
  toolName: string,
  params: unknown,
  resources: (string | null)[] = [],
  options: SummarizeOptions = {}
): ApprovalPrompt | { exceeded: SummaryLimit } {
  return approvalPromptFor(toolName, summarizeCall(params, options), resources);
}
