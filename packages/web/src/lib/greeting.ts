import { getSetting, setSetting } from "@/lib/settings";

export async function shouldTriggerGreeting(): Promise<boolean> {
  const pending = await getSetting("onboarding_greeting_pending");
  return pending === "true";
}

export async function markGreetingSent(): Promise<void> {
  await setSetting("onboarding_greeting_pending", "false", false);
}
