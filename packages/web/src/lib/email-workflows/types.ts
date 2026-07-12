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

// Status domains live in db/enums.ts (single source of truth, DB CHECK-enforced).
// Re-exported here under the domain-facing names for lib/email-workflows consumers.
export {
  PROCESSED_EMAIL_STATUSES as PROCESSED_STATUSES,
  type ProcessedEmailStatus as ProcessedStatus,
} from "@/db/enums";
