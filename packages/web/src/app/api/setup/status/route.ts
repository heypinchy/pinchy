import { NextResponse } from "next/server";
import { isSetupComplete } from "@/lib/setup";

export async function GET() {
  try {
    const complete = await isSetupComplete();
    return NextResponse.json({ setupComplete: complete });
  } catch {
    return NextResponse.json(
      { error: "Unable to check setup status" },
      { status: 503 }
    );
  }
}
