import { z } from "zod";
import { odooCredentialsSchema, odooConnectionDataSchema } from "@/lib/integrations/odoo-schema";

/**
 * Request schemas for the integration-connect wizard's four routes, shared
 * with `add-integration-dialog.tsx` (AGENTS.md § "Shared Schemas And Typed
 * Client"). `@/lib/integrations/odoo-schema` imports nothing but zod, so it is
 * safe in a client bundle.
 */

/** `POST /api/integrations/list-databases` — probe an Odoo host for db names. */
export const listDatabasesSchema = z.object({
  url: z.string().url(),
});
export type ListDatabasesInput = z.infer<typeof listDatabasesSchema>;

/** `POST /api/integrations/test-credentials` — probe before anything is saved. */
export const testCredentialsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("odoo"),
    credentials: z.object({
      url: z.string().url(),
      db: z.string().min(1),
      login: z.string().min(1),
      apiKey: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("web-search"),
    credentials: z.object({
      apiKey: z.string().min(1),
    }),
  }),
]);
export type TestCredentialsInput = z.infer<typeof testCredentialsSchema>;

/** `POST /api/integrations/sync-preview` — read the Odoo schema, save nothing. */
export const syncPreviewSchema = z.object({
  type: z.literal("odoo"),
  credentials: z.object({
    url: z.string().url(),
    db: z.string().min(1),
    login: z.string().min(1),
    apiKey: z.string().min(1),
    uid: z.number().int().positive(),
  }),
});
export type SyncPreviewInput = z.infer<typeof syncPreviewSchema>;

/** `POST /api/integrations` — create the connection with everything at once. */
export const createIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("odoo"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: odooCredentialsSchema,
    data: odooConnectionDataSchema.optional(),
  }),
  z.object({
    type: z.literal("web-search"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: z.object({ apiKey: z.string().min(1) }),
  }),
]);
/** Pre-parse shape — `description` has a default the caller may omit. */
export type CreateIntegrationInput = z.input<typeof createIntegrationSchema>;
