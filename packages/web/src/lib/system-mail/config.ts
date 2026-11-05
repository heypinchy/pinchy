import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import {
  systemMailConfigSchema,
  type SystemMailConfig,
  type SystemMailStatus,
} from "@/lib/schemas/system-mail";

/**
 * The system mailer's configuration lives in ONE encrypted settings row: the
 * password means nothing without the host it belongs to, and a half-written
 * config is a state no reader should have to handle. No row means "off" —
 * there is deliberately no separate enabled flag that could disagree with it.
 */
export const SYSTEM_MAIL_SETTING_KEY = "system_mail";

export async function getSystemMailConfig(): Promise<SystemMailConfig | null> {
  let raw: string | null;
  try {
    raw = await getSetting(SYSTEM_MAIL_SETTING_KEY);
  } catch {
    // Encrypted under a key this install no longer has (secrets volume
    // recreated, ENCRYPTION_KEY changed). Off, so the admin can set it up
    // again instead of every mail route answering 500 for good.
    console.error("[system-mail] stored config can't be decrypted; treating the mailer as off");
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[system-mail] stored config is not JSON; treating the mailer as off");
    return null;
  }
  const result = systemMailConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error("[system-mail] stored config no longer validates; treating the mailer as off");
    return null;
  }
  return result.data;
}

export async function saveSystemMailConfig(config: SystemMailConfig): Promise<void> {
  await setSetting(SYSTEM_MAIL_SETTING_KEY, JSON.stringify(config), true);
}

export async function deleteSystemMailConfig(): Promise<void> {
  await deleteSetting(SYSTEM_MAIL_SETTING_KEY);
}

export async function isSystemMailConfigured(): Promise<boolean> {
  return (await getSystemMailConfig()) !== null;
}

export function toPublicConfig(
  config: SystemMailConfig
): Extract<SystemMailStatus, { configured: true }>["config"] {
  const { password, ...rest } = config;
  return { ...rest, hasPassword: Boolean(password) };
}

/**
 * The settings form never receives the stored password, so a `PUT` without
 * one means "keep it". Two exceptions, both about where a secret may go:
 * without a username there is no AUTH and so no password; and a password is
 * never carried over to a different host — it was typed for the server it was
 * typed for.
 */
export function mergeWithStoredPassword(
  update: SystemMailConfig,
  stored: SystemMailConfig | null
): SystemMailConfig {
  if (!update.username) return { ...update, password: undefined };
  if (update.password) return update;
  // Host names are case-insensitive; a re-typed "SMTP.example.com" is the same server.
  if (stored && stored.host.toLowerCase() === update.host.toLowerCase()) {
    return { ...update, password: stored.password };
  }
  return update;
}
