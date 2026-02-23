import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readFileSync } from "fs";

const DATA_DIRECTORIES_JSON = "/openclaw-config/data-directories.json";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const json = readFileSync(DATA_DIRECTORIES_JSON, "utf-8");
    const data = JSON.parse(json);
    return NextResponse.json({ directories: data.directories });
  } catch {
    return NextResponse.json({ directories: [] });
  }
}
