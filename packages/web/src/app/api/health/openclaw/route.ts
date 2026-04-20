import { NextResponse } from "next/server";
import { restartState } from "@/server/restart-state";
import { openClawConnectionState } from "@/server/openclaw-connection-state";

export async function GET() {
  if (restartState.isRestarting) {
    return NextResponse.json({
      status: "restarting",
      connected: false,
      since: restartState.triggeredAt,
    });
  }
  return NextResponse.json({ status: "ok", connected: openClawConnectionState.connected });
}
