import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { fetchProviderModels } from "@/lib/provider-models";

export const GET = withAuth(async () => {
  const providers = await fetchProviderModels();
  return NextResponse.json({ providers });
});
