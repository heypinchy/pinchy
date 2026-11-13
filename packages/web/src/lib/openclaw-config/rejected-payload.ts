// The postmortem dump of a payload the #311 size guard refused.
//
// It sits next to openclaw.json on the shared volume, and the payload it holds
// is a full openclaw.json: `gateway.auth.token`, every plugin's `gatewayToken`
// (the one secret that lets a caller inside the OpenClaw container read any
// connection's credentials) and every Telegram `botToken`, in plaintext. So the
// dump keeps the structure the postmortem needs and none of those values, is
// readable by its owner only, and only the newest few survive — a guard that
// trips on every regenerate must not fill the volume with copies of the token.

import { readdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

type Json = Record<string, unknown>;

export const MAX_REJECTED_PAYLOADS = 5;

const REDACTED = "[redacted]";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace `key` of `record` with a marker when it is present. */
function redactKey(record: unknown, key: string): void {
  if (isRecord(record) && key in record) record[key] = REDACTED;
}

/**
 * The payload with its credentials replaced by a marker. Content that does not
 * parse as JSON is not written at all: it could carry the very values this
 * exists to keep out.
 */
export function redactRejectedPayload(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "[unparseable payload omitted: it could not be checked for credentials]\n";
  }
  if (isRecord(parsed)) {
    if (isRecord(parsed.gateway)) redactKey(parsed.gateway.auth, "token");
    if (isRecord(parsed.plugins) && isRecord(parsed.plugins.entries)) {
      for (const entry of Object.values(parsed.plugins.entries)) {
        if (isRecord(entry)) redactKey(entry.config, "gatewayToken");
      }
    }
    if (isRecord(parsed.channels) && isRecord(parsed.channels.telegram)) {
      const accounts = parsed.channels.telegram.accounts;
      if (isRecord(accounts)) {
        for (const account of Object.values(accounts)) redactKey(account, "botToken");
      }
    }
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}

/**
 * Write the redacted dump (mode 0600) and drop all but the newest
 * MAX_REJECTED_PAYLOADS. Best-effort: the caller's error log carries the
 * salient facts either way, so nothing here throws. Returns the dump's path.
 */
export function writeRejectedPayload(configPath: string, content: string, stamp: string): string {
  const path = `${configPath}.regenerate-rejected.${stamp}`;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the config path + ISO timestamp, no user input
    writeFileSync(path, redactRejectedPayload(content), { encoding: "utf-8", mode: 0o600 });
  } catch {
    return path;
  }
  try {
    const prefix = `${basename(configPath)}.regenerate-rejected.`;
    const dir = dirname(configPath);
    // The stamp is a sortable ISO timestamp, so name order is age order.
    const dumps = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of dumps.slice(0, Math.max(0, dumps.length - MAX_REJECTED_PAYLOADS))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- name was listed from the config's own directory
      unlinkSync(join(dir, name));
    }
  } catch {
    // Pruning is housekeeping; a failure must not hide the refusal.
  }
  return path;
}
