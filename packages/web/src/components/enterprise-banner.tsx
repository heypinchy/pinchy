"use client";

import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import type { LicenseState } from "@/lib/license-state";
import { evaluateSeatPressure } from "@/lib/seat-grace";
import {
  BUY_PRO_URL,
  PRICING_URL,
  PORTAL_URL,
  SALES_MAILTO,
  CALENDLY_URL,
  conversionLink,
} from "@/lib/conversion-links";

const REFETCH_INTERVAL_MS = 15 * 60 * 1000;
const RENEWAL_WINDOW_MS = 14 * 86400000;
const DISMISS_PREFIX = "pinchy-banner-dismissed:";

interface LicenseInfo {
  enterprise: boolean;
  state: LicenseState;
  type: string | null;
  daysRemaining: number | null;
  expiresAt: string | null;
  paidUntil: string | null;
  seatsUsed: number;
  maxUsers: number;
}

interface BannerLink {
  label: string;
  href: string;
}

interface Banner {
  /** Dismissal scope — a new state shows the banner again. */
  key: string;
  tone: "info" | "warn";
  message: string;
  links: BannerLink[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * License-lifecycle banner per the pricing concept's § 6 state table.
 * Factual copy, no countdowns, no guilt — and never red: an expired
 * license is a renewal task, not an emergency.
 */
function licenseBanner(license: LicenseInfo, now: Date): Banner | null {
  const { state, daysRemaining, expiresAt, paidUntil } = license;
  const periodEnd = paidUntil ?? expiresAt;

  switch (state) {
    case "trial": {
      if (daysRemaining === null) return null;
      const days = `${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}`;
      return {
        key: "license:trial",
        tone: daysRemaining <= 7 ? "warn" : "info",
        message: `Trial: ${days} remaining.`,
        links: [
          { label: "Buy Pinchy Pro", href: conversionLink(BUY_PRO_URL, "trial-banner", "pro-10") },
          { label: "Compare plans", href: conversionLink(PRICING_URL, "trial-banner", "pro-10") },
        ],
      };
    }
    case "trial-expired":
      return {
        key: "license:trial-expired",
        tone: "warn",
        message: `Your trial ended${expiresAt ? ` on ${formatDate(expiresAt)}` : ""}. Your configuration is preserved.`,
        links: [
          { label: "See pricing", href: conversionLink(PRICING_URL, "expired-banner", "pro-10") },
        ],
      };
    case "paid": {
      // Renewal reminder from paidUntil − 14d (§ 4.7). Keys issued before
      // the paidUntil claim existed encode no grace — there, exp IS the
      // period end, so the window anchors on exp instead.
      if (!periodEnd) return null;
      const ends = new Date(periodEnd).getTime();
      if (now.getTime() < ends - RENEWAL_WINDOW_MS) return null;
      return {
        key: "license:renewal",
        tone: "info",
        message: `Your license period ends on ${formatDate(periodEnd)}. Your renewal key arrives by email after payment.`,
        links: [{ label: "Renew", href: conversionLink(PORTAL_URL, "expired-banner", "pro-10") }],
      };
    }
    case "grace":
      return {
        key: "license:grace",
        tone: "warn",
        message: `License period ended${periodEnd ? ` ${formatDate(periodEnd)}` : ""}.${expiresAt ? ` Grace until ${formatDate(expiresAt)}.` : ""}`,
        links: [{ label: "Renew", href: conversionLink(PORTAL_URL, "expired-banner", "pro-10") }],
      };
    case "expired":
      return {
        key: "license:expired",
        tone: "warn",
        message: `Your license period ended${periodEnd ? ` on ${formatDate(periodEnd)}` : ""}. Existing access restrictions remain enforced; management features are locked.`,
        links: [{ label: "Renew", href: conversionLink(PORTAL_URL, "expired-banner", "pro-10") }],
      };
    case "community":
      return null;
  }
}

/**
 * Seat-pressure banner (§ 5): factual, never red, dismissible. Phase A has
 * a single SKU, so more seats go through the quote path — no checkout links.
 */
function seatBanner(license: LicenseInfo): Banner | null {
  if (!license.enterprise) return null;
  const pressure = evaluateSeatPressure(license.seatsUsed, license.maxUsers);
  if (!pressure.overCap) return null;
  return {
    key: "seats",
    tone: "info",
    message: `You're using ${license.seatsUsed} of ${license.maxUsers} licensed seats. Grace seats keep a new hire from waiting on procurement.`,
    links: [
      { label: "Email us for a quote", href: SALES_MAILTO },
      { label: "Book a call", href: CALENDLY_URL },
    ],
  };
}

function BannerBar({ banner, onDismiss }: { banner: Banner; onDismiss: (key: string) => void }) {
  const toneClass =
    banner.tone === "warn" ? "bg-amber-500 text-white" : "bg-muted text-foreground border-b";
  return (
    <div role="alert" className={`relative px-8 py-2 text-sm text-center ${toneClass}`}>
      {banner.message}{" "}
      {banner.links.map((link, i) => (
        <span key={link.href}>
          {i > 0 && <span className="mx-1 opacity-60">·</span>}
          <a
            href={link.href}
            target={link.href.startsWith("mailto:") ? undefined : "_blank"}
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            {link.label}
          </a>
        </span>
      ))}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(banner.key)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function EnterpriseBanner({ isAdmin }: { isAdmin: boolean }) {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [, setDismissTick] = useState(0);

  const fetchStatus = useCallback(() => {
    fetch("/api/enterprise/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setLicense(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetchStatus();

    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchStatus();
    };
    const onLicenseUpdated = () => fetchStatus();
    const interval = setInterval(fetchStatus, REFETCH_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("license-updated", onLicenseUpdated);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("license-updated", onLicenseUpdated);
    };
  }, [isAdmin, fetchStatus]);

  if (!isAdmin || !license) return null;

  const dismiss = (key: string) => {
    sessionStorage.setItem(`${DISMISS_PREFIX}${key}`, "1");
    setDismissTick((t) => t + 1);
  };
  const isDismissed = (key: string) => sessionStorage.getItem(`${DISMISS_PREFIX}${key}`) === "1";

  const banners = [licenseBanner(license, new Date()), seatBanner(license)].filter(
    (b): b is Banner => b !== null && !isDismissed(b.key)
  );

  if (banners.length === 0) return null;

  return (
    <>
      {banners.map((banner) => (
        <BannerBar key={banner.key} banner={banner} onDismiss={dismiss} />
      ))}
    </>
  );
}
