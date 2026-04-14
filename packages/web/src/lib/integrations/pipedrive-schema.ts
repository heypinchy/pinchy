import { z } from "zod";

export const pipedriveCredentialsSchema = z.object({
  apiToken: z.string().min(1),
  companyDomain: z.string().min(1),
  companyName: z.string().min(1),
  userId: z.number().int().positive(),
  userName: z.string().min(1),
});

export type PipedriveCredentials = z.infer<typeof pipedriveCredentialsSchema>;

const pipedriveFieldOptionSchema = z.object({
  id: z.number(),
  label: z.string(),
});

const pipedriveFieldSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(pipedriveFieldOptionSchema).optional(),
});

const pipedriveEntitySchema = z.object({
  entity: z.string(),
  name: z.string(),
  category: z.string(),
  fields: z.array(pipedriveFieldSchema).optional(),
  operations: z.object({
    read: z.boolean(),
    create: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
  }),
});

export const pipedriveConnectionDataSchema = z.object({
  entities: z.array(pipedriveEntitySchema),
  lastSyncAt: z.string().datetime(),
});

export type PipedriveConnectionData = z.infer<typeof pipedriveConnectionDataSchema>;

/** Strip sensitive fields from decrypted credentials for API responses. */
export function maskPipedriveCredentials(
  encryptedCredentials: string,
  decrypt: (ciphertext: string) => string
): { companyDomain: string; companyName: string; userName: string } {
  const parsed = JSON.parse(decrypt(encryptedCredentials));
  return {
    companyDomain: parsed.companyDomain,
    companyName: parsed.companyName,
    userName: parsed.userName,
  };
}
