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

export const PROCESSED_STATUSES = ["processing", "done", "no_action", "failed"] as const;
export type ProcessedStatus = (typeof PROCESSED_STATUSES)[number];
