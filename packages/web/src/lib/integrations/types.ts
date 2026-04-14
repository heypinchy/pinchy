export interface IntegrationConnection {
  id: string;
  type: string;
  name: string;
  description: string;
  credentials: Record<string, string | boolean>;
  data: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
