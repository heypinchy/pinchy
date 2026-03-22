"use client";

import { useState, useEffect } from "react";
import { Shield, ShieldOff } from "lucide-react";

export function DevToolbar() {
  const [enterprise, setEnterprise] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    fetch("/api/enterprise/status")
      .then((r) => r.json())
      .then((data) => setEnterprise(data.enterprise ?? false))
      .catch(() => setEnterprise(false));
  }, []);

  async function toggle() {
    setToggling(true);
    try {
      const res = await fetch("/api/dev/enterprise-toggle", { method: "POST" });
      const data = await res.json();
      setEnterprise(data.enterprise);
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
