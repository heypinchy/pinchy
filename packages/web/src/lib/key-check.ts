// The `check-keys` command: what Pinchy will sign and encrypt with when it
// starts, in plain words, for an operator who has just restored keys and has
// not started Pinchy yet. Reads through inspectSecret, so it parses the
// variables and reads the key files exactly the way startup does — the
// hand-written shell checks this replaces kept drifting from that.
//
// Never prints a key, a hash of a key, or any part of one.

import { inspectSecret, type IgnoredSecretReason, type SecretInspection } from "@/lib/encryption";

export type CheckedSecret = "audit_hmac_secret" | "encryption_key";

export interface KeyCheckResult {
  lines: string[];
  needsAction: boolean;
}

const WHY_IGNORED: Record<IgnoredSecretReason, string> = {
  "0x-prefix": "starts with 0x",
  "not-hex": "contains characters other than 0-9 and a-f",
  length: "is not 64 characters long",
};

const FIX = "Fix this before you start Pinchy";

function variableLine(envVar: string, variable: SecretInspection["variable"]): string {
  switch (variable.status) {
    case "unset":
      return `${envVar}: not set`;
    case "valid":
      return `${envVar}: set, a valid key`;
    case "ignored":
      return (
        `${envVar}: set, but Pinchy ignores it: it ${WHY_IGNORED[variable.reason]}. ` +
        "A valid key is 64 hex characters (0-9, a-f)."
      );
  }
}

function fileLine(file: string, envVar: string, state: SecretInspection["file"]): string {
  switch (state.status) {
    case "missing":
      return `${file}: no such file`;
    case "unreadable":
      return `${file}: can't be read (${state.code})`;
    case "invalid":
      return `${file}: not a valid key (empty, or not 64 hex characters)`;
    case "key":
      return `${file}: holds a key`;
    case "same":
      return `${file}: holds the same key as ${envVar}`;
    case "different":
      return `${file}: holds a different key than ${envVar}`;
  }
}

/** The result line for the audit key, and whether it needs fixing. */
function auditResult({ variable, file }: SecretInspection): [string, boolean] {
  const env = "AUDIT_HMAC_SECRET";
  const path = ".audit_hmac_secret";
  if (variable.status === "valid") {
    switch (file.status) {
      case "same":
        return [`Pinchy signs audit entries with ${env}. There is no earlier key.`, false];
      case "missing":
        return [
          `Pinchy signs audit entries with ${env} and writes it to ${path} when it starts. ` +
            "There is no earlier key.",
          false,
        ];
      case "different":
        return [
          `Pinchy signs audit entries with ${env} and accepts the key in ${path} as the earlier key.`,
          false,
        ];
      case "unreadable":
        return [
          `${FIX}: it signs audit entries with ${env} but can't read ${path}, so it has no ` +
            "earlier key. Don't remove the file, it may be the earlier key: it has to be a " +
            "file, owned by Pinchy's user (uid 999).",
          true,
        ];
      default:
        return [
          `${FIX}: it signs audit entries with ${env}, but ${path} isn't a key, so it has no ` +
            "earlier key.",
          true,
        ];
    }
  }
  switch (file.status) {
    case "missing":
      return [
        `${FIX}, unless this install has never written an audit entry: there is no audit ` +
          "signing key, so Pinchy generates a new one, and entries signed before can't be " +
          "verified with it.",
        true,
      ];
    case "unreadable":
      return [`${FIX}: it would sign audit entries with ${path}, but can't read it.`, true];
    case "invalid":
      return [`${FIX}: it would sign audit entries with ${path}, but it isn't a key.`, true];
    default:
      return variable.status === "ignored"
        ? [
            `${FIX}: it ignores ${env} and signs audit entries with the key in ${path}. ` +
              "There is no earlier key.",
            true,
          ]
        : [`Pinchy signs audit entries with the key in ${path}. There is no earlier key.`, false];
  }
}

/** The result line for the encryption key, and whether it needs fixing. */
function encryptionResult({ variable, file }: SecretInspection): [string, boolean] {
  const env = "ENCRYPTION_KEY";
  const path = ".encryption_key";
  if (variable.status === "valid") {
    return [`Pinchy encrypts stored credentials with ${env} and doesn't read ${path}.`, false];
  }
  switch (file.status) {
    case "missing":
      return [
        `${FIX}, unless this install has never saved a credential: there is no encryption ` +
          "key, so Pinchy generates a new one the first time it encrypts or decrypts " +
          "something, and credentials saved with an earlier key can't be read.",
        true,
      ];
    case "unreadable":
      return [`${FIX}: it would encrypt stored credentials with ${path}, but can't read it.`, true];
    case "invalid":
      return [
        `${FIX}: it would encrypt stored credentials with ${path}, but it isn't a key.`,
        true,
      ];
    default:
      return variable.status === "ignored"
        ? [
            `${FIX}: it ignores ${env} and encrypts stored credentials with the key in ${path}.`,
            true,
          ]
        : [`Pinchy encrypts stored credentials with the key in ${path}.`, false];
  }
}

export function describeKeyCheck(
  secret: CheckedSecret,
  inspection: SecretInspection
): KeyCheckResult {
  const envVar = secret.toUpperCase();
  const [result, needsAction] =
    secret === "audit_hmac_secret" ? auditResult(inspection) : encryptionResult(inspection);
  return {
    lines: [
      variableLine(envVar, inspection.variable),
      fileLine(`.${secret}`, envVar, inspection.file),
      result,
    ],
    needsAction,
  };
}

export function runKeyCheck(): { text: string; needsAction: boolean } {
  const results = (["audit_hmac_secret", "encryption_key"] as const).map((secret) =>
    describeKeyCheck(secret, inspectSecret(secret))
  );
  return {
    text: results.map((r) => r.lines.join("\n")).join("\n\n"),
    needsAction: results.some((r) => r.needsAction),
  };
}
