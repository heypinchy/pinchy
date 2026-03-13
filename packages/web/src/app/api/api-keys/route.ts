import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { createApiKey, listApiKeys } from "@/lib/api-keys";

/** List all API keys for the current user. */
export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keys = await listApiKeys(session.user.id);
  return NextResponse.json({ keys });
}

/** Create a new API key. */
export async function POST(request: NextRequest) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name, scopes, expiresInDays } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : undefined;

  const result = await createApiKey({
    name: name.trim(),
    userId: session.user.id,
    scopes: Array.isArray(scopes) ? scopes : ["read"],
    expiresAt,
  });

  // Return the plaintext key — this is the ONLY time it's shown
  return NextResponse.json({
    key: result.key,
    id: result.id,
    keyPrefix: result.keyPrefix,
    message: "Save this key now — it won't be shown again.",
  });
}
