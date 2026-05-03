import { NextResponse } from "next/server";
import { isOpenClawConfigReady } from "@/lib/openclaw-config-ready";

export function GET() {
  if (isOpenClawConfigReady()) {
    return NextResponse.json({ ready: true });
  }
  return NextResponse.json({ ready: false }, { status: 503 });
}
