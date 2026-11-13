// The postmortem dump of a payload the #311 size guard refused.
//
// It sits next to openclaw.json on the shared volume, and the payload it holds
// is a full openclaw.json: `gateway.auth.token`, every plugin's `gatewayToken`
// (the one secret that lets a caller inside the OpenClaw container read any
// connection's credentials) and every Telegram `botToken`, in plaintext. So the
// dump keeps the structure the postmortem needs and none of those values, is
// readable by its owner only, and only the newest few survive — a guard that
// trips on every regenerate must not fill the volume with copies of the token.

import { chmodSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { findPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";

type Json = Record<string, unknown>;

export const MAX_REJECTED_PAYLOADS = 5;

const REDACTED = "[redacted]";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECRET_KEY = /token|secret|password|apikey|api_key|authorization/i;

/** A URL value without userinfo or query string (both can carry credentials). */
function stripUrlCredentials(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function redactTree(node: unknown): unknown {
  if (typeof node === "string") return stripUrlCredentials(node);
  if (Array.isArray(node)) return node.map(redactTree);
  if (isRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redactTree(value),
      ])
    );
  }
  return node;
}

/**
 * The payload with its credentials replaced by a marker: every value under a
 * credential-looking key (over-redacting is fine), URL userinfo and queries,
 * and, as a backstop for a secret sitting under an innocent key, nothing is
 * written at all if the plaintext scanner still finds a provider key. Content
 * that does not parse as JSON is not written either: it could carry the very
 * values this exists to keep out.
 */
export function redactRejectedPayload(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "[unparseable payload omitted: it could not be checked for credentials]\n";
  }
  const redacted = redactTree(parsed);
  if (findPlaintextSecrets(redacted).length > 0) {
    return "[payload omitted: a plaintext provider key survived redaction]\n";
  }
  return JSON.stringify(redacted, null, 2) + "\n";
}

/**
 * Keep only the newest MAX_REJECTED_PAYLOADS dumps, and make the survivors
 * safe: dumps written by older versions are 0644 and hold plaintext tokens, so
 * each is rewritten redacted at 0600 (idempotent for a dump already clean).
 * Best-effort; never throws.
 */
export function sweepRejectedPayloads(configPath: string): void {
  try {
    const prefix = `${basename(configPath)}.regenerate-rejected.`;
    const dir = dirname(configPath);
    // The stamp is a sortable ISO timestamp, so name order is age order.
    const names = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort();
    const cut = Math.max(0, names.length - MAX_REJECTED_PAYLOADS);
    names.forEach((name, i) => {
      const path = join(dir, name);
      try {
        if (i < cut) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- name was listed from the config's own directory
          unlinkSync(path);
        } else {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- name was listed from the config's own directory
          const redacted = redactRejectedPayload(readFileSync(path, "utf-8"));
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- name was listed from the config's own directory
          writeFileSync(path, redacted, { encoding: "utf-8", mode: 0o600 });
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- name was listed from the config's own directory
          chmodSync(path, 0o600);
        }
      } catch {
        // One unreadable dump must not stop the sweep of the others.
      }
    });
  } catch {
    // Housekeeping; a missing directory is the normal case in tests.
  }
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
  sweepRejectedPayloads(configPath);
  return path;
}

let sweptThisProcess = false;

/**
 * The sweep, once per process: run it on the first regenerate after a boot so
 * dumps older versions left behind are cleaned even when no new refusal ever
 * happens (the fix removes the common trigger).
 */
export function sweepRejectedPayloadsOnce(configPath: string): void {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  sweepRejectedPayloads(configPath);
}

/** Test seam: forget that the sweep ran. */
export function _resetRejectedPayloadSweep(): void {
  sweptThisProcess = false;
}
