"use client";

import { useParams } from "next/navigation";

/**
 * Reads the `[token]` route param from a dynamic page (e.g. `/invite/[token]`,
 * `/reset/[token]`) and narrows it to a single string. Next.js types the param
 * as `string | string[]`, but our routes only have a single segment.
 */
export function useTokenParam(): string | undefined {
  const params = useParams();
  const raw = params.token;
  return Array.isArray(raw) ? raw[0] : raw;
}
