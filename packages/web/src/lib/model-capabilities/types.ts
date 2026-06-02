/**
 * Shared capability types — no DB imports, safe for client components.
 */

export type ModelCapabilities = {
  vision: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
  longContext: boolean;
  tools: boolean;
};
