"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, TriangleAlert } from "lucide-react";

// Keep in sync with SecretsProvenance in @/lib/secret-source — duplicated
// here because the server lib must not be bundled into a client component.
interface SecretsInfo {
  encryption_key: "envvar" | "file" | "unset";
  auth_secret: "envvar" | "file" | "unset";
  audit_hmac_secret: "envvar" | "file" | "unset";
  db_password: "custom" | "default" | "generated";
}

const SOURCE_LABELS: Record<string, string> = {
  envvar: "Environment variable",
  file: "Persisted file (Docker volume)",
  unset: "Not created yet — generated on first use",
};

function SecretRow({ name, label }: { name: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span>{name}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Shows where this instance's secrets come from (issue #156) — provenance
 * only, values never leave the server. Renders nothing when /api/health
 * doesn't expose the info (older server during a rolling upgrade).
 */
export function SecretsProvenanceCard() {
  const [secrets, setSecrets] = useState<SecretsInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data.secrets) setSecrets(data.secrets);
      } catch {
        // Health endpoint unreachable — simply don't render the card.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!secrets) return null;

  const defaultDbPassword = secrets.db_password === "default";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5" />
          Secrets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Where this instance&apos;s secrets come from. Environment variables override persisted
          files. Values never leave the server.
        </p>
        <SecretRow name="Encryption key" label={SOURCE_LABELS[secrets.encryption_key]} />
        <SecretRow
          name="Auth secret"
          label={secrets.auth_secret === "unset" ? "Not set" : SOURCE_LABELS[secrets.auth_secret]}
        />
        <SecretRow name="Audit signing secret" label={SOURCE_LABELS[secrets.audit_hmac_secret]} />
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>Database password</span>
          {defaultDbPassword ? (
            <span className="flex items-center gap-1.5 text-amber-600">
              <TriangleAlert className="size-4" />
              Default password — set DB_PASSWORD in your .env
            </span>
          ) : (
            <span className="text-muted-foreground">
              {secrets.db_password === "generated"
                ? "Auto-generated (Docker volume)"
                : "Custom password"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
