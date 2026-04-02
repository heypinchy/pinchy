import { getSetting } from "@/lib/settings";
import { isSetupComplete } from "@/lib/setup";

export async function getDomain(): Promise<string | null> {
  return getSetting("domain");
}

export async function isInsecureMode(): Promise<boolean> {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) return false;
  const domain = await getDomain();
  return domain === null;
}
