import { NextRequest, NextResponse } from "next/server";
import { getSession, type Session } from "@/lib/auth";
import { validateApiKey } from "@/lib/api-keys";
import { headers } from "next/headers";

interface ApiAuthResult {
  userId: string;
  authMethod: "session" | "api-key";
  scopes?: string[];
}

/**
 * Authenticate a request via session cookie OR API key.
 *
 * API keys are passed via:
 *   - Authorization: Bearer pnch_...
 *   - X-API-Key: pnch_...
 *
 * Returns null if authentication fails.
 */
export async function authenticateRequest(
  request: NextRequest
): Promise<ApiAuthResult | null> {
  // Try API key first (for programmatic access)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    const result = await validateApiKey(apiKey);
    if (result) {
      return {
        userId: result.userId,
        authMethod: "api-key",
        scopes: result.scopes,
      };
    }
    return null; // Invalid API key
  }

  // Fall back to session cookie (for browser access)
  const session = await getSession({ headers: await headers() });
  if (session?.user?.id) {
    return {
      userId: session.user.id,
      authMethod: "session",
    };
  }

  return null;
}

/**
 * Check if the authenticated request has a required scope.
 */
export function hasScope(auth: ApiAuthResult, scope: string): boolean {
  // Session-based auth has all scopes
  if (auth.authMethod === "session") return true;
  // API key must have the specific scope
  return auth.scopes?.includes(scope) ?? false;
}

/**
 * Extract API key from request headers.
 */
function extractApiKey(request: NextRequest): string | null {
  // Check Authorization: Bearer pnch_...
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer pnch_")) {
    return authHeader.slice(7);
  }

  // Check X-API-Key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey?.startsWith("pnch_")) {
    return xApiKey;
  }

  return null;
}

/**
 * Helper to return 401 response.
 */
export function unauthorizedResponse(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Helper to return 403 response.
 */
export function forbiddenResponse(scope: string) {
  return NextResponse.json(
    { error: `Insufficient permissions. Required scope: ${scope}` },
    { status: 403 }
  );
}
