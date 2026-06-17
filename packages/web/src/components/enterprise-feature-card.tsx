"use client";

import { useState } from "react";
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
  /**
   * Provided by the parent (which already fetched /api/enterprise/status) —
   * the card itself never fetches. Defaults to community, the only state in
   * which a gated surface renders without any license info.
   */
  licenseState?: LicenseState;
  /** ISO date the license period ended (paidUntil, or exp as fallback). */
  periodEnd?: string | null;
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
  licenseState = "community",
  periodEnd = null,
}: EnterpriseFeatureCardProps) {
  const [cliffOpen, setCliffOpen] = useState(false);

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
          <span className="text-xs font-normal bg-primary/10 text-primary-accent px-2 py-0.5 rounded-full">
            Pro
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground">{description}</p>
        <Button onClick={() => setCliffOpen(true)}>{ctaLabel(licenseState)}</Button>
        <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
          <p className="text-sm font-medium">How to enable</p>
          <p className="text-sm text-muted-foreground">
            Set your license key in{" "}
            <a href="/settings?tab=license" className="text-primary-accent underline">
              Settings → License
            </a>
            , or via the{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">PINCHY_ENTERPRISE_KEY</code>{" "}
            environment variable.
          </p>
        </div>
      </CardContent>
      <LicenseCliffDialog
        open={cliffOpen}
        onOpenChange={setCliffOpen}
        feature={feature}
        description={description}
        campaign={campaign}
        licenseState={licenseState}
        periodEnd={periodEnd}
      />
    </Card>
  );
}
