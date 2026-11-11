"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import type { GrantedFolder } from "@/lib/granted-folder-status";

/**
 * Whether each of an agent's saved folder grants still exists (#1363), from
 * `GET /api/agents/:id/granted-folders`.
 *
 * `savedPathsKey` names the saved grants; the check runs again when it
 * changes, so a grant removed and saved stops being reported. The route is
 * admin-only, so callers pass `enabled` rather than collecting a 403.
 *
 * A failed check answers `undefined`: the picker then shows grants as they
 * are stored, which is what it did before this check existed — better than
 * marking working folders as broken.
 */
export function useGrantedFolders(
  agentId: string,
  savedPathsKey: string,
  enabled: boolean
): GrantedFolder[] | undefined {
  const [folders, setFolders] = useState<GrantedFolder[] | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    apiGet<{ folders: GrantedFolder[] }>(
      `/api/agents/${encodeURIComponent(agentId)}/granted-folders`
    ).then(
      (data) => current && setFolders(data.folders),
      () => current && setFolders(undefined)
    );
    return () => {
      current = false;
    };
  }, [agentId, savedPathsKey, enabled]);

  return enabled ? folders : undefined;
}
