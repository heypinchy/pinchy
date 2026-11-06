import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { sanitizePath } from "@/lib/path-validation";
import { listDataSubdirectories } from "@/lib/data-subdirectories";

/**
 * One level of subfolders below a `/data` mount, for the directory picker
 * (#1269). The picker expands one folder at a time — see
 * `lib/data-subdirectories.ts` for why lazy, and for the symlink rules.
 *
 * Admin-only. Granting a folder is an admin action (`PATCH /api/agents/:id`
 * refuses `pluginConfig` from anyone else), and the names of folders inside a
 * share — `layoffs-2027`, a customer's name — are information in their own
 * right. The top-level list stays readable by every signed-in user, as before.
 *
 * `searchParams.get` decodes the query string once. The decoded value goes
 * through `sanitizePath` (the same boundary every stored grant passes) and is
 * never decoded again, so a double-encoded `..` stays a literal folder name.
 */
export const GET = withAdmin(async (request) => {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  try {
    sanitizePath(path);
  } catch {
    return NextResponse.json({ error: "Path must be a folder under /data" }, { status: 400 });
  }

  const result = await listDataSubdirectories(path);
  if (!result.ok) {
    return result.reason === "invalid_path"
      ? NextResponse.json({ error: "Path must be a folder below a /data mount" }, { status: 400 })
      : NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  return NextResponse.json({ directories: result.directories, truncated: result.truncated });
});
