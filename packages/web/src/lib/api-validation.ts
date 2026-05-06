import { NextRequest, NextResponse } from "next/server";
import type { ZodError, ZodType } from "zod";

export type ParseResult<T> = { data: T } | { error: NextResponse };

/**
 * Build the canonical 400 NextResponse for a failed Zod parse. Routes that
 * cannot use `parseRequestBody` directly (e.g. routes that pick a sub-schema
 * dynamically based on a DB lookup) should call this so the error contract
 * stays identical to `parseRequestBody`'s.
 */
export function formatValidationError(error: ZodError): NextResponse {
  return NextResponse.json(
    { error: "Validation failed", details: error.flatten() },
    { status: 400 }
  );
}

/**
 * Validate a JSON request body against a Zod schema. Returns either parsed
 * data or a structured 400 NextResponse. Use this in every state-mutating
 * API route instead of calling `request.json()` directly — it also catches
 * malformed JSON (which would otherwise throw a 500).
 */
export async function parseRequestBody<T>(
  schema: ZodType<T>,
  request: NextRequest
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      error: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: formatValidationError(parsed.error) };
  }

  return { data: parsed.data };
}
