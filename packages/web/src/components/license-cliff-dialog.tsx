"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { LicenseState } from "@/lib/license-state";
import {
  PRICING_URL,
  PRICING_TRIAL_URL,
  PORTAL_URL,
  conversionLink,
  type UtmCampaign,
} from "@/lib/conversion-links";

interface LicenseCliffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the gated feature, e.g. "Groups". */
  feature: string;
  /** Two sentences of benefit, shared with the feature card. */
  description: string;
  campaign: UtmCampaign;
  licenseState: LicenseState;
  /** ISO date the license period ended (paidUntil, or exp as fallback). */
  periodEnd: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The cliff modal from pricing concept § 6: shown when an admin reaches a
 * license-gated feature. Factual copy per license state, a plain "Not now"
 * to dismiss — no guilt copy, no countdowns.
 */
export function LicenseCliffDialog({
  open,
  onOpenChange,
  feature,
  description,
  campaign,
  licenseState,
  periodEnd,
}: LicenseCliffDialogProps) {
  const ended = periodEnd ? ` on ${formatDate(periodEnd)}` : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{feature} is included in Pinchy Pro</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {licenseState === "trial-expired" && (
          <p className="text-sm">Your trial ended{ended}. Your configuration is preserved.</p>
        )}
        {licenseState === "expired" && (
          <p className="text-sm">
            Your license period ended{ended}. Existing access restrictions remain enforced;
            management features are locked.
          </p>
        )}
        {licenseState === "community" && (
          <p className="text-sm text-muted-foreground">30 days, no credit card, key by email.</p>
        )}

        <DialogFooter className="sm:justify-start gap-2">
          {licenseState === "community" && (
            <>
              <a
                href={conversionLink(PRICING_TRIAL_URL, "cliff-modal", campaign)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button>Start free 30-day trial</Button>
              </a>
              <a
                href={conversionLink(PRICING_URL, "cliff-modal", campaign)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline">See pricing</Button>
              </a>
            </>
          )}
          {licenseState === "trial-expired" && (
            <a
              href={conversionLink(PRICING_URL, "cliff-modal", campaign)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button>See pricing</Button>
            </a>
          )}
          {licenseState === "expired" && (
            <a
              href={conversionLink(PORTAL_URL, "cliff-modal", campaign)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button>Renew</Button>
            </a>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
