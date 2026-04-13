export interface IntegrationConnection {
  id: string;
  type: string;
  name: string;
  description: string;
  credentials:
    | {
        url: string;
        db: string;
        login: string;
      }
    | string;
  data: {
    lastSyncAt?: string;
    models?: Array<{ model: string; name: string }>;
    categories?: unknown[];
    emailAddress?: string;
    provider?: string;
    connectedAt?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
