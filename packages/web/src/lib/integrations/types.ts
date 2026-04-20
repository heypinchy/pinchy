export interface IntegrationConnection {
  id: string;
  type: string; // "odoo" | "pipedrive" | "google"
  name: string;
  description: string;
  credentials: Record<string, unknown> | string | null; // Masked credentials — shape varies by type
  data: Record<string, unknown> | null; // Cached sync data — shape varies by type
  status: "active" | "pending";
  createdAt: string;
  updatedAt: string;
  cannotDecrypt: boolean;
}
