"use client";

import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useTabParam, SETTINGS_TABS, type SettingsTab } from "@/hooks/use-tab-param";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsContext } from "@/components/settings-context";
import { SettingsProfile } from "@/components/settings-profile";
import { SettingsGroups } from "@/components/settings-groups";
import { SettingsIntegrations } from "@/components/settings-integrations";

import { SettingsLicense } from "@/components/settings-license";
import { TelegramLinkSettings } from "@/components/telegram-link-settings";
import { SettingsSecurity } from "@/components/settings-security";
import { TimezoneSettings } from "@/components/timezone-settings";
import { SecretsProvenanceCard } from "@/components/secrets-provenance-card";
import { SettingsSupport } from "@/components/settings-support";
import { useIntegrationHealth } from "@/hooks/use-integration-health";
import type { LicenseInfo } from "@/lib/enterprise";

interface ProviderStatus {
  defaultProvider: string | null;
  providers: Record<string, { configured: boolean }>;
}

function DirtyDot() {
  return (
    <span
      className="ml-1 size-1.5 rounded-full bg-amber-500 inline-block"
      aria-label="unsaved changes"
    />
  );
}

function ErrorDot() {
  return (
    <span
      className="ml-1 size-1.5 rounded-full bg-destructive inline-block"
      aria-label="needs attention"
    />
  );
}

// Display labels for the mobile drill-down back header. Kept in sync with
// the TabsTrigger labels below (the "AI Provider" label disambiguates the
// LLM provider tab from OAuth "providers" like Google/Microsoft).
const TAB_LABELS: Record<SettingsTab, string> = {
  context: "Context",
  profile: "Profile",
  telegram: "Telegram",
  support: "Support",
  provider: "AI Provider",
  users: "Users",
  groups: "Groups",
  integrations: "Integrations",
  organization: "Organization",
  license: "License",
  security: "Security",
};

export function SettingsPageContent({
  initialTab,
  isAdmin,
  initialLicense,
  oauthError,
}: {
  initialTab?: string;
  isAdmin: boolean;
  initialLicense?: LicenseInfo;
  oauthError?: string;
}) {
  const { data: session } = authClient.useSession();
  const pathname = usePathname();
  const router = useRouter();
  const visibleTabs: SettingsTab[] = isAdmin
    ? [...SETTINGS_TABS]
    : ["context", "profile", "telegram", "support"];
  const [activeTab, setActiveTab, isTabExplicit] = useTabParam("context", visibleTabs, initialTab, {
    keepParamForDefault: true,
  });
  // Mark the (admin-only) Integrations tab when a connection needs attention, so
  // the error trail continues from the sidebar badge down to the exact tab.
  const { needsAttentionCount } = useIntegrationHealth(isAdmin);

  // On mobile, `isTabExplicit` drives a two-level drill-down: the sidebar list
  // (level 1) vs. a selected tab's content with a back header (level 2).
  // Desktop always shows the split layout regardless of this flag.
  const goToMenu = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [userContext, setUserContext] = useState("");
  const [orgContext, setOrgContext] = useState("");

  const [providerDirty, setProviderDirty] = useState(false);
  const [contextDirty, setContextDirty] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [enterpriseRefreshKey, setEnterpriseRefreshKey] = useState(0);

  const handleEnterpriseActivated = useCallback(() => {
    setEnterpriseRefreshKey((k) => k + 1);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/providers");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchContext = useCallback(async () => {
    const userRes = await fetch("/api/users/me/context");
    if (userRes.ok) {
      const data = await userRes.json();
      setUserContext(data.content || "");
    }
  }, []);

  const fetchOrgContext = useCallback(async () => {
    const orgRes = await fetch("/api/settings/context");
    if (orgRes.ok) {
      const data = await orgRes.json();
      setOrgContext(data.content || "");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (isAdmin) {
        void fetchStatus();
        void fetchOrgContext();
      }
      void fetchContext();
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, fetchStatus, fetchContext, fetchOrgContext]);

  const handleProviderDirtyChange = useCallback((isDirty: boolean) => {
    setProviderDirty(isDirty);
  }, []);

  const handleContextDirtyChange = useCallback((isDirty: boolean) => {
    setContextDirty(isDirty);
  }, []);

  const handleProfileDirtyChange = useCallback((isDirty: boolean) => {
    setProfileDirty(isDirty);
  }, []);

  // No `overflow-y-auto` here: AppShell's wrapper (`flex-1 overflow-y-auto`)
  // is already the real, height-bounded page scroller. A second nested
  // `overflow-y-auto` on an auto-height div still counts as a CSS scroll
  // container even though it never overflows itself, which makes it the
  // (non-scrolling) containing block for `position: sticky` below and
  // silently breaks the sticky sidebar. Keep this single-scroller structure.
  return (
    <div>
      <div className="p-4 md:p-8 max-w-5xl">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          orientation="vertical"
          className="flex-col md:flex-row md:gap-10"
        >
          {isTabExplicit && (
            <div className="flex items-center gap-2 pb-2 md:hidden">
              <button
                type="button"
                onClick={goToMenu}
                aria-label="Back to settings"
                className="text-muted-foreground hover:text-foreground -ml-1 rounded-md px-1 py-1 text-sm font-medium"
              >
                &lsaquo; Settings
              </button>
              <span className="text-sm font-medium">{TAB_LABELS[activeTab]}</span>
            </div>
          )}

          <TabsList
            variant="sidebar"
            className={cn(
              "h-fit w-full shrink-0 flex-col items-stretch gap-0.5 md:sticky md:top-0 md:w-56 md:self-start md:overflow-y-auto md:max-h-[calc(100dvh-4rem)]",
              isTabExplicit ? "hidden md:flex" : "flex md:flex"
            )}
          >
            <div
              role="presentation"
              className="text-muted-foreground/70 px-2 pt-1 pb-1 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase"
            >
              Personal
            </div>
            <TabsTrigger value="context">Context {contextDirty && <DirtyDot />}</TabsTrigger>
            <TabsTrigger value="profile">Profile {profileDirty && <DirtyDot />}</TabsTrigger>
            <TabsTrigger value="telegram">Telegram</TabsTrigger>
            <TabsTrigger value="support">Support</TabsTrigger>
            {isAdmin && (
              <>
                <div
                  role="presentation"
                  className="text-muted-foreground/70 px-2 pt-6 pb-1 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase"
                >
                  Administration
                </div>
                <TabsTrigger value="provider">
                  AI Provider {providerDirty && <DirtyDot />}
                </TabsTrigger>
                <TabsTrigger value="users">Users</TabsTrigger>
                <TabsTrigger value="groups">Groups</TabsTrigger>
                <TabsTrigger value="integrations">
                  Integrations {needsAttentionCount > 0 && <ErrorDot />}
                </TabsTrigger>
                <TabsTrigger value="organization">Organization</TabsTrigger>
                <div
                  role="presentation"
                  className="text-muted-foreground/70 px-2 pt-6 pb-1 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase"
                >
                  Security &amp; Compliance
                </div>
                <TabsTrigger value="security">Security</TabsTrigger>
                <TabsTrigger value="license">License</TabsTrigger>
              </>
            )}
          </TabsList>

          <div className={cn("min-w-0 flex-1", isTabExplicit ? "block" : "hidden md:block")}>
            {isAdmin && (
              <TabsContent value="security">
                <div className="space-y-6">
                  <SettingsSecurity />
                  <SecretsProvenanceCard />
                </div>
              </TabsContent>
            )}

            <TabsContent value="context" keepMounted>
              <SettingsContext
                userContext={userContext}
                orgContext={orgContext}
                isAdmin={isAdmin}
                onDirtyChange={handleContextDirtyChange}
              />
            </TabsContent>

            <TabsContent value="profile" keepMounted>
              <SettingsProfile
                userName={session?.user?.name ?? ""}
                onDirtyChange={handleProfileDirtyChange}
              />
            </TabsContent>

            <TabsContent value="telegram">
              <TelegramLinkSettings isAdmin={isAdmin} />
            </TabsContent>

            <TabsContent value="support">
              <SettingsSupport />
            </TabsContent>

            {isAdmin && (
              <TabsContent value="provider" keepMounted>
                <Card>
                  <CardHeader>
                    <CardTitle>LLM Provider</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {loading ? (
                      <p>Loading...</p>
                    ) : (
                      <ProviderKeyForm
                        onSuccess={fetchStatus}
                        submitLabel="Save"
                        configuredProviders={status?.providers}
                        defaultProvider={status?.defaultProvider}
                        onDirtyChange={handleProviderDirtyChange}
                      />
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="users" keepMounted>
                <SettingsUsers
                  currentUserId={session?.user?.id ?? ""}
                  refreshKey={enterpriseRefreshKey}
                />
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="groups" keepMounted>
                <SettingsGroups refreshKey={enterpriseRefreshKey} isAdmin={isAdmin} />
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="integrations" keepMounted>
                <SettingsIntegrations oauthError={oauthError} />
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="organization" keepMounted>
                <TimezoneSettings />
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="license" keepMounted>
                <SettingsLicense
                  onEnterpriseActivated={handleEnterpriseActivated}
                  initialLicense={initialLicense}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
