import { getSetting } from "@/lib/settings";

export async function getDomain(): Promise<string | null> {
  return getSetting("domain");
}
