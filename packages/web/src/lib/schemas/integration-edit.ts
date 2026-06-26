import { z } from "zod";

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

// MCP credential edit = token rotation. extraHeaders (e.g. HighLevel's
// locationId) lives on connection.data and is reused during re-discovery,
// so the edit form only rotates the token.
export const mcpEditSchema = z.object({
  token: z.string().optional(),
});
