import { z } from "zod";

/**
 * `POST /api/setup` — the first-run admin. Shared with `setup-form.tsx`
 * (AGENTS.md § "Shared Schemas And Typed Client").
 *
 * `password` is shape-only: the length/breach-list policy is enforced
 * post-parse via `validatePassword()`, so setup, invite-claim and
 * password-change cannot drift apart.
 */
export const setupSchema = z.object({
  name: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "Name is required"),
  email: z.string().email("A valid email address is required"),
  password: z.string(),
  browserTimezone: z.string().optional(),
});
/** Pre-parse shape — `name` is trimmed by the schema, not by the caller. */
export type SetupInput = z.input<typeof setupSchema>;
