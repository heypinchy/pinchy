import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchProviderModels } from "@/lib/provider-models";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = await fetchProviderModels();

  return NextResponse.json({ providers });
}
