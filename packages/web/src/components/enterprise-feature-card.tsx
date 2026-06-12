"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LicenseCliffDialog } from "@/components/license-cliff-dialog";
import type { LicenseState } from "@/lib/license-state";
import type { UtmCampaign } from "@/lib/conversion-links";

interface EnterpriseFeatureCardProps {
  feature: string;
  description: string;
  campaign: UtmCampaign;
  isAdmin: boolean;
}

interface CliffStatus {
  state: LicenseState;
  periodEnd: string | null;
}

function ctaLabel(state: LicenseState): string {
  switch (state) {
    case "trial-expired":
      return "See pricing";
    case "expired":
      return "Renew";
    default:
      return "Start free 30-day trial";
  }
}

/**
 * Replacement surface for a license-gated feature. Admins get the feature
 * pitch and the cliff modal (§ 6); non-admins only get a factual pointer —
 * employees of a customer are not a marketing audience.
 */
export function EnterpriseFeatureCard({
  feature,
  description,
  campaign,
  isAdmin,
}: EnterpriseFeatureCardProps) {
  const [status, setStatus] = useState<CliffStatus | null>(null);
  const [cliffOpen, setCliffOpen] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/enterprise/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setStatus({ state: data.state, periodEnd: data.paidUntil ?? data.expiresAt ?? null });
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            This feature requires a Pro license. Ask your administrator.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {feature}
          <span className="text-xs font-normal bg-primary/10 text-primary px-2 py-0.5 rounded-full">
            Pro
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground">{description}</p>
        {status && <Button onClick={() => setCliffOpen(true)}>{ctaLabel(status.state)}</Button>}
        <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
          <p className="text-sm font-medium">How to enable</p>
          <p className="text-sm text-muted-foreground">
            Set your license key in{" "}
            <a href="/settings?tab=license" className="text-primary underline">
              Settings → License
            </a>
            , or via the{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">PINCHY_ENTERPRISE_KEY</code>{" "}
            environment variable.
          </p>
        </div>
      </CardContent>
      {status && (
        <LicenseCliffDialog
          open={cliffOpen}
          onOpenChange={setCliffOpen}
          feature={feature}
          description={description}
          campaign={campaign}
          licenseState={status.state}
          periodEnd={status.periodEnd}
        />
      )}
    </Card>
  );
}
