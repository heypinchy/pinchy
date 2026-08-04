import { z } from "zod";

/**
 * `PUT /api/enterprise/key` — activate a license key. Shared with
 * `settings-license.tsx` (AGENTS.md § "Shared Schemas And Typed Client").
 */
export const setLicenseKeySchema = z.object({ key: z.string().min(1) });
export type SetLicenseKeyInput = z.infer<typeof setLicenseKeySchema>;
