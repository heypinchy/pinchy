import { getSetting, setSetting } from "@/lib/settings";

const TIMEZONE_KEY = "org.timezone";

export async function getOrgTimezone(): Promise<string> {
  const value = await getSetting(TIMEZONE_KEY);
  return value ?? "UTC";
}

export async function setOrgTimezone(timezone: string): Promise<void> {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
  await setSetting(TIMEZONE_KEY, timezone);
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
