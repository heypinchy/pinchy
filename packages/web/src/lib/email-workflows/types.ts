export interface EmailWorkflowFilter {
  from?: string[];
  toDomain?: string[];
  subjectContains?: string[];
  hasAttachment?: boolean;
  attachmentType?: string; // e.g. "application/pdf"
  folder?: string;
}

export interface ProcessedEmailOutcome {
  odooModel?: string;
  odooId?: number;
  link?: string;
  note?: string;
}

export interface EmailAttachment {
  contentType: string;
  filename?: string;
}

/**
 * A mailbox message as the dispatcher sees it: the deterministic fields the
 * filter runs against plus the claim keys. Sourced from `pinchy-email`'s
 * `email_search`/`email_read`, never from the LLM.
 */
export interface DispatchableEmail {
  /** Provider immutable id (Graph id / Gmail message id) — the dedup/claim key. */
  providerMessageId: string;
  /**
   * RFC 5322 `Message-ID`, stored for cross-provider traceability. NOT part of
   * the claim's uniqueness — dedup is `(workflowId, connectionId,
   * providerMessageId)` only (see {@link claimEmail}).
   */
  messageIdHeader?: string;
  /** Normalized sender address (no display name). */
  from: string;
  /** Normalized recipient addresses (To + Cc). */
  to: string[];
  subject: string;
  folder?: string;
  attachments: EmailAttachment[];
  receivedAt: Date;
}

// Status domains live in db/enums.ts (single source of truth, DB CHECK-enforced).
// Re-exported here under the domain-facing names for lib/email-workflows consumers.
export {
  PROCESSED_EMAIL_STATUSES as PROCESSED_STATUSES,
  type ProcessedEmailStatus as ProcessedStatus,
} from "@/db/enums";
