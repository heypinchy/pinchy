import { z } from "zod";

export const createGroupSchema = z.object({
  name: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "Name is required"),
  description: z.string().nullish(),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullish(),
});
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const setMembersSchema = z.object({
  userIds: z.array(z.string()),
});
export type SetMembersInput = z.infer<typeof setMembersSchema>;
