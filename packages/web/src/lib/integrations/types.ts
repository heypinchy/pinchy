export interface IntegrationConnection {
  id: string;
  type: string; // "odoo" | "pipedrive"
  name: string;
  description: string;
  credentials: Record<string, unknown>; // Masked credentials — shape varies by type
  data: Record<string, unknown> | null; // Cached sync data — shape varies by type
  createdAt: string;
  updatedAt: string;
}
