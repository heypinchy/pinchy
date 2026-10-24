import { createDecipheriv } from "crypto";

/**
 * Which resources a tool call touches, so the confirmation policy can be read
 * per resource and not only per tool (#1133).
 *
 * Two sources, and neither is a hand-maintained table:
 *
 * 1. An explicit `model` parameter — `odoo_read` / `create` / `write` /
 *    `delete` / `count` / `aggregate` take one.
 * 2. The opaque `_pinchy_ref` tokens the record-action tools take instead
 *    (`odoo_confirm_order`, `odoo_validate_picking`, `odoo_reconcile`, …).
 *    **The ref carries its own model**, so reading it beats mirroring a
 *    tool→model list from the plugin: a list is wrong the moment someone adds
 *    a ref tool and forgets it, and it needs a drift guard to say so. A ref
 *    cannot drift from itself, and a new ref tool works here on the day it
 *    ships.
 *
 * The decode half of pinchy-odoo's `integration-ref.ts` is reimplemented rather
 * than imported: the plugin resolves its key from a container path
 * (`/openclaw-secrets/secrets.json`) that pinchy-web has no business reading,
 * and pinchy-web already holds the same key in its settings DB, which is where
 * it was generated. What keeps the two in step is `call-models.test.ts`, which
 * encodes with the plugin's own encoder and decodes here — a format change
 * fails that round trip immediately, where a textual comparison would let a
 * changed IV length through.
 */

const PREFIX = "pinchy_ref:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * A resource the call touches. `null` is one we could not name — a ref that
 * did not decode, or none configured. It is deliberately not the same as "no
 * resource": the call still acts on something, so it must inherit the
 * tool-level setting rather than fall through to allow.
 */
export type CallResource = string | null;

function decodeRefModel(ref: string, key: string): string | null {
  try {
    const raw = Buffer.from(ref.slice(PREFIX.length), "base64url");
    if (raw.length <= IV_LENGTH + TAG_LENGTH) return null;
    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.from(key, "hex"),
      raw.subarray(0, IV_LENGTH)
    );
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8");
    const payload: unknown = JSON.parse(plaintext);
    if (!payload || typeof payload !== "object") return null;
    const model = (payload as Record<string, unknown>).model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    // Every decode failure is the same answer here — an unnamed resource.
    // Telling a garbled ref from a rotated key matters to the tool that has to
    // explain itself to the model; it does not change what the gate must do.
    return null;
  }
}

/**
 * Walks the call's arguments for resources. Refs are found by their prefix
 * wherever they sit — no parameter-name list, because the tools spell it
 * `target`, `targetRef`, `moveRef`, … and a name list is the same maintenance
 * trap as a model table.
 */
export function collectCallModels(params: unknown, key: string | null): CallResource[] {
  const found: CallResource[] = [];
  const usableKey = key && HEX_64.test(key) ? key : null;

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith(PREFIX)) {
        found.push(usableKey ? decodeRefModel(value, usableKey) : null);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };

  if (params && typeof params === "object" && !Array.isArray(params)) {
    const explicit = (params as Record<string, unknown>).model;
    // Scoped by tool name downstream (`<tool>:<model>`), so a non-Odoo tool
    // that happens to carry a `model` argument produces a key nobody has
    // configured — which inherits the tool setting and changes nothing.
    if (typeof explicit === "string" && explicit.length > 0) found.push(explicit);
  }
  visit(params);

  return found;
}
