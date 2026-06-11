import { NextResponse } from "next/server";
import { getSecretsProvenance } from "@/lib/secret-source";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    // Issue #156: provenance only ("envvar" | "file" | "unset" /
    // "custom" | "default") — never secret values. Lets operators see from
    // the shell whether the file fallback is active before rotating
    // anything (rotating an auto-generated encryption key loses data).
    secrets: getSecretsProvenance(),
  });
}
