import { z } from "zod";

export const odooCredentialsSchema = z.object({
  url: z.string().url(),
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
