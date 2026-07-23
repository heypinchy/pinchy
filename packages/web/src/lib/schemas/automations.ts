import { z } from "zod";

import type { EmailWorkflowFilter } from "@/lib/email-workflows/types";
import type { EmailWorkflowStatus } from "@/db/enums";

/**
 * The deterministic trigger of an email workflow (design §5). Every field is
 * optional and AND-combined by the matcher; an empty filter watches the whole
 * mailbox. Structurally a subset of {@link EmailWorkflowFilter} — the parity
 * guard below fails to compile if the two drift apart, so the request shape can
 * never accept a field the dispatcher doesn't understand.
 */
export const automationFilterSchema = z.object({
  from: z.array(z.string().min(1)).optional(),
  toDomain: z.array(z.string().min(1)).optional(),
  subjectContains: z.array(z.string().min(1)).optional(),
  hasAttachment: z.boolean().optional(),
  attachmentType: z.string().min(1).optional(),
  folder: z.string().min(1).optional(),
});

// Compile-time guard (type-only, no runtime effect): the parsed filter must be
// assignable to the type the dispatcher reads. If the two drift, the constraint
// `T extends EmailWorkflowFilter` fails and this alias stops compiling. Exported
// so it counts as used — its whole job is to make `tsc` fail on drift.
export type AssertAssignable<T extends U, U> = T;
export type FilterParity = AssertAssignable<
  z.infer<typeof automationFilterSchema>,
  EmailWorkflowFilter
>;

/** Upper bound on the workflow name — a label, not prose. */
export const AUTOMATION_NAME_MAX_LENGTH = 200;

/**
 * Upper bound on mailboxes per workflow. Far above any real setup, but keeps
 * an absurd request from ballooning the 400-error echo and the audit
 * `detail.connectionIds` list (AGENTS.md: keep audit detail under 2048 bytes).
 */
export const AUTOMATION_MAX_CONNECTIONS = 50;

/**
 * Request schema for POST /api/automations — the single write path for the
 * Inbox Agent's email workflows (design §5). Both the Automations form (#139)
 * and the conversational create tool (#705) send this exact shape, so the
 * route, the client, and the tool share one contract (AGENTS.md, "Shared
 * Schemas And Typed Client").
 *
 * The route always writes the workflow `pending` + `disabled` regardless of
 * this payload — activation is a separate, human-gated step (propose, don't
 * self-activate), so enablement is deliberately NOT a field here.
 */
export const createAutomationSchema = z.object({
  agentId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(AUTOMATION_NAME_MAX_LENGTH)
    .refine((v) => v.trim().length > 0, "Name is required"),
  filter: automationFilterSchema.default({}),
  action: z.string().min(1),
  // At least one mailbox: a workflow with no connection is never dispatched
  // (the loader inner-joins email_workflow_connections), so it would be inert.
  connectionIds: z.array(z.string().min(1)).min(1).max(AUTOMATION_MAX_CONNECTIONS),
  // How far back the reconciliation sweep re-lists (design §5). Bounded so a
  // typo can't make one workflow re-hydrate years of mail every pass.
  sweepWindowDays: z.number().int().positive().max(365).default(14),
});

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

/**
 * Request schema for PATCH /api/automations/[id]. Deliberately narrow: `enabled`
 * is the one knob a human flips to activate (or pause) a proposed workflow —
 * the human-gated step that "propose, don't self-activate" reserves for a
 * person. Editing name/filter/action belongs to the Automations form (#139), not
 * this toggle.
 */
export const updateAutomationSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

/**
 * Client-side contract for one row of GET /api/automations?agentId — the shape
 * the Automations tab (#139) renders. `createdAt` is a string here (JSON has no
 * Date), whereas the route works with a `Date` before serialization; that is the
 * one deliberate divergence from the route's in-memory row type. Kept beside the
 * request schemas so the tab, the tool, and any future consumer share one source
 * of truth for the workflow's read shape.
 */
export interface AutomationListItem {
  id: string;
  name: string;
  filter: EmailWorkflowFilter;
  action: string;
  enabled: boolean;
  status: EmailWorkflowStatus;
  sweepWindowDays: number;
  createdBy: string | null;
  createdAt: string;
  connectionIds: string[];
}

/**
 * Client-side contract for one mailbox choice in the Automations create form's
 * picker — GET /api/automations/connections?agentId. The endpoint resolves these
 * through the same email-read permission gate the create route (POST) enforces,
 * so the picker can never offer a connection the create route would reject.
 */
export interface AutomationConnectionOption {
  id: string;
  name: string;
}
