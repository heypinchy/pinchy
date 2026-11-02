import { z } from "zod";

/**
 * An Odoo server URL. 2048 characters is longer than any real one, and it bounds
 * what an edit's destination diff can put into an audit row.
 */
export const odooUrlSchema = z
  .string()
  .max(2048, "The URL is too long — 2048 characters at most.")
  .url();

export const odooCredentialsSchema = z.object({
  url: odooUrlSchema,
  db: z.string().min(1),
  login: z.string().min(1),
  apiKey: z.string().min(1),
  uid: z.number().int().positive(),
});

export type OdooCredentials = z.infer<typeof odooCredentialsSchema>;

const odooFieldSchema = z.object({
  name: z.string(),
  string: z.string(),
  type: z.string(),
  required: z.boolean(),
  readonly: z.boolean(),
  relation: z.string().optional(),
  selection: z.array(z.tuple([z.string(), z.string()])).optional(),
});

const odooModelSchema = z.object({
  model: z.string(),
  name: z.string(),
  fields: z.array(odooFieldSchema),
  access: z
    .object({
      read: z.boolean(),
      create: z.boolean(),
      write: z.boolean(),
      delete: z.boolean(),
    })
    .optional(), // optional for backward compat with old syncs
});

export const odooConnectionDataSchema = z.object({
  models: z.array(odooModelSchema),
  lastSyncAt: z.string().datetime(),
});

export type OdooConnectionData = z.infer<typeof odooConnectionDataSchema>;

/** Strip sensitive fields from decrypted credentials for API responses. */
export function maskCredentials(
  encryptedCredentials: string,
  decrypt: (ciphertext: string) => string
): { url: string; db: string; login: string } {
  const parsed = JSON.parse(decrypt(encryptedCredentials));
  return { url: parsed.url, db: parsed.db, login: parsed.login };
}
