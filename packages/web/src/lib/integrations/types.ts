export interface IntegrationConnection {
  id: string;
  type: string;
  name: string;
  description: string;
  credentials: {
    url: string;
    db: string;
    login: string;
  } | null;
  data: {
    lastSyncAt?: string;
    models?: Array<{ model: string; name: string }>;
  } | null;
  createdAt: string;
  updatedAt: string;
  cannotDecrypt: boolean;
}
