import { z } from "zod";

import { senderNameSchema } from "@/lib/schemas/sender-name";

// `PATCH /api/integrations/[connectionId]` — the connection envelope itself
// (rename/describe/re-credential), as opposed to the per-type credential
// shapes below. Shared with `use-integration-actions.ts` so a rename payload
// cannot drift from what the route accepts. `.passthrough()` is deliberate:
// the route merges unknown keys into the credential blob for types that
// validate them separately.
export const updateConnectionSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

// All fields optional — empty string means "leave current value unchanged".
// The submit handler filters out empty strings before sending the PATCH body.
export const odooEditSchema = z.object({
  url: z.string().optional(),
  db: z.string().optional(),
  login: z.string().optional(),
  apiKey: z.string().optional(),
});

export const webSearchEditSchema = z.object({
  apiKey: z.string().optional(),
});

// IMAP reconnect/edit contract. Single source of truth — imported by BOTH the
// client edit dialog (edit-credentials-dialog.tsx) and the PATCH route
// ([connectionId]/route.ts) so the two sides can't drift (AGENTS.md "Shared
// Schemas And Typed Client"). All fields optional ("leave empty to keep
// current"); the submit handler strips empty strings before validating, so
// any field that IS present must be non-empty. Ports are coerced so the form
// can carry prefilled string values, and `.strict()` rejects stray keys.
export const imapEditSchema = z
  .object({
    imapHost: z.string().min(1).optional(),
    imapPort: z.coerce.number().int().min(1).max(65535).optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    security: z.enum(["tls", "starttls", "none"]).optional(),
    // From-header display name. Literally the same rule object as
    // imapCreateSchema uses — see schemas/sender-name.ts.
    senderName: senderNameSchema.optional(),
  })
  .strict();
