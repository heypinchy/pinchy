import { z } from "zod";

/**
 * Display name for the From header of agent-sent mail ("Clemens Helm
 * <clemens@example.com>"). NOT the integration label.
 *
 * CR/LF is rejected here as the first header-injection barrier; the plugin
 * adapter guards again at send/draft time (defense in depth).
 *
 * Shared by the create schema (`schemas/imap.ts`) and the edit schema
 * (`schemas/integration-edit.ts`) rather than written twice (#1087). A security
 * guard kept in two copies is one refactor away from being kept in one, and the
 * half that loses the `.refine` accepts a header injection while still looking
 * validated — the drift nobody notices until it is a CVE.
 *
 * Callers add `.optional()` themselves: both current users treat the field as
 * "leave empty to keep current", but that is their contract, not this rule's.
 */
export const senderNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !/[\r\n]/.test(v), {
    message: "Sender name must not contain line breaks",
  });
