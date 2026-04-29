"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

const REFETCH_INTERVAL_MS = 15 * 60 * 1000;

interface LicenseInfo {
  enterprise: boolean;
  type: string | null;
  daysRemaining: number | null;
  expiresAt: string | null;
}

function shouldShowBanner(license: LicenseInfo): {
  show: boolean;
  variant: "warning" | "destructive";
  message: string;
  linkText: string;
  linkHref: string;
} {
  const { enterprise, type, daysRemaining, expiresAt } = license;
  const noShow = {
    show: false,
    variant: "warning" as const,
    message: "",
    linkText: "",
    linkHref: "",
  };

  // Expired (had a license but it's no longer active, and we have expiry info)
  if (!enterprise && expiresAt && daysRemaining !== null && daysRemaining <= 0) {
    return {
      show: true,
      variant: "destructive",
      message: "Your enterprise license has expired. Enterprise features are deactivated.",
      linkText: "Enter new key \u2192",
      linkHref: "/settings?tab=license",
    };
  }

  if (!enterprise) return noShow;

  if (type === "trial") {
    if (daysRemaining !== null && daysRemaining <= 3) {
      return {
        show: true,
        variant: "destructive",
        message: `Your trial expires in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}.`,
        linkText: "Upgrade \u2192",
        linkHref: "https://heypinchy.com/enterprise?utm_source=app&utm_medium=banner",
      };
    }
    if (daysRemaining !== null && daysRemaining <= 7) {
      return {
        show: true,
        variant: "warning",
        message: `Your trial expires in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}.`,
        linkText: "Upgrade \u2192",
        linkHref: "https://heypinchy.com/enterprise?utm_source=app&utm_medium=banner",
      };
    }
  }

  if (type === "paid") {
    if (daysRemaining !== null && daysRemaining <= 7) {
      return {
        show: true,
        variant: "destructive",
        message: `Your license expires in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}.`,
        linkText: "Renew \u2192",
        linkHref: "https://heypinchy.com/enterprise?utm_source=app&utm_medium=banner",
      };
    }
    if (daysRemaining !== null && daysRemaining <= 30) {
      return {
        show: true,
        variant: "warning",
        message: `Your license expires in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}.`,
        linkText: "Renew \u2192",
        linkHref: "https://heypinchy.com/enterprise?utm_source=app&utm_medium=banner",
      };
    }
  }

  return noShow;
}

export function EnterpriseBanner({ isAdmin }: { isAdmin: boolean }) {
  const [banner, setBanner] = useState<ReturnType<typeof shouldShowBanner> | null>(null);

  const fetchStatus = useCallback(() => {
    fetch("/api/enterprise/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setBanner(shouldShowBanner(data));
        }
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

  if (!isAdmin || !banner?.show) return null;

  const isExternal = banner.linkHref.startsWith("http");
  const bgClass =
    banner.variant === "destructive" ? "bg-destructive text-white" : "bg-amber-500 text-white";

  return (
    <div role="alert" className={`px-4 py-2 text-sm text-center ${bgClass}`}>
      {banner.message}{" "}
      {isExternal ? (
        <a
          href={banner.linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          {banner.linkText}
        </a>
      ) : (
        <Link href={banner.linkHref} className="underline font-medium">
          {banner.linkText}
        </Link>
      )}
    </div>
  );
}
