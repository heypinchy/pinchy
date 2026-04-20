import { getSetting, setSetting, deleteSetting } from "@/lib/settings";

export const SUBSCRIPTION_KEY = "openai_subscription_oauth";

export interface OpenAiSubscription {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  accountId: string;
  accountEmail: string;
  connectedAt: string; // ISO
  lastRefreshAt?: string; // ISO, optional
  refreshFailureCount: number;
}

export async function getOpenAiSubscription(): Promise<OpenAiSubscription | null> {
  const raw = await getSetting(SUBSCRIPTION_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as OpenAiSubscription;
}

export async function setOpenAiSubscription(sub: OpenAiSubscription): Promise<void> {
  await setSetting(SUBSCRIPTION_KEY, JSON.stringify(sub), true);
}

export async function deleteOpenAiSubscription(): Promise<void> {
  await deleteSetting(SUBSCRIPTION_KEY);
}
