import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { listDataMounts } from "@/lib/data-subdirectories";

/**
 * GET /api/data-directories — the folders directly under `/data`, for the
 * directory picker's top level.
 *
 * Read live on every request (see listDataMounts): a list cached at start-up
 * kept offering a mount after it was renamed or deleted (#1363).
 */
export const GET = withAuth(async () => {
  return NextResponse.json({ directories: await listDataMounts() });
});
