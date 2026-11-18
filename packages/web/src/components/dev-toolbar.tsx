"use client";

import { useState } from "react";
import { Shield, ShieldOff } from "lucide-react";
import { apiPost } from "@/lib/api-client";
import { useLicenseStatus } from "@/hooks/use-license-status";

export function DevToolbar() {
  // Unknown (a status fetch dropped by a tsx-watch restart) renders no badge
  // rather than a "Community" one the server never said.
  const enterprise = useLicenseStatus().license?.enterprise ?? null;
  const [toggling, setToggling] = useState(false);

  async function toggle() {
    setToggling(true);
    try {
      await apiPost<{ enterprise: boolean }>("/api/dev/enterprise-toggle", undefined);
      // Reload to reflect enterprise state across the app
      window.location.reload();
    } catch {
      setToggling(false);
    }
  }

  if (enterprise === null) return null;

  return (
    <div className="fixed bottom-3 right-3 z-50 flex items-center gap-1.5 rounded-lg bg-foreground/90 px-3 py-1.5 text-xs text-background shadow-lg">
      <button
        onClick={toggle}
        disabled={toggling}
        className="flex items-center gap-1.5 hover:opacity-80 transition-opacity disabled:opacity-50"
        title={enterprise ? "Disable enterprise" : "Enable enterprise"}
      >
        {enterprise ? (
          <>
            <Shield className="size-3.5" />
            <span>Enterprise</span>
          </>
        ) : (
          <>
            <ShieldOff className="size-3.5" />
            <span>Community</span>
          </>
        )}
      </button>
    </div>
  );
}
