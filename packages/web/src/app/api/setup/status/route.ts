import { NextResponse } from "next/server";
import { isSetupComplete } from "@/lib/setup";
import { checkDatabase, checkOpenClaw } from "@/lib/infrastructure";

export async function GET() {
  try {
    const [complete, database, openclaw] = await Promise.all([
      isSetupComplete(),
      checkDatabase(),
      checkOpenClaw(),
    ]);
    return NextResponse.json({
      setupComplete: complete,
      infrastructure: { database, openclaw },
    });
  } catch {
    return NextResponse.json({ error: "Unable to check setup status" }, { status: 503 });
  }
}
