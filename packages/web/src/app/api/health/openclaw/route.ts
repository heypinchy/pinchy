import { NextResponse } from "next/server";
import { restartState } from "@/server/restart-state";

export async function GET() {
  if (restartState.isRestarting) {
    return NextResponse.json({ status: "restarting", since: restartState.triggeredAt });
  }
  return NextResponse.json({ status: "ok" });
}
