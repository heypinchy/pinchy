"use client";

import { useState, useEffect, useCallback } from "react";
import { authClient } from "@/lib/auth-client";
import { useTabParam, SETTINGS_TABS, type SettingsTab } from "@/hooks/use-tab-param";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsContext } from "@/components/settings-context";
import { SettingsProfile } from "@/components/settings-profile";
import { SettingsGroups } from "@/components/settings-groups";
import { SettingsLicense } from "@/components/settings-license";
import { TelegramLinkSettings } from "@/components/telegram-link-settings";
import { SettingsSecurity } from "@/components/settings-security";

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

interface LicenseInfo {
  enterprise: boolean;
  type: string | null;
  org: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  managedByEnv: boolean;
}

export function SettingsPageContent({
  initialTab,
  isAdmin,
  initialLicense,
}: {
  initialTab?: string;
  isAdmin: boolean;
  initialLicense?: LicenseInfo;
}) {
  const { data: session } = authClient.useSession();
  const visibleTabs: SettingsTab[] = isAdmin
    ? [...SETTINGS_TABS]
    : ["context", "profile", "telegram"];
  const [activeTab, setActiveTab] = useTabParam("context", visibleTabs, initialTab);

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
    if (isAdmin) {
      fetchStatus();
      fetchOrgContext();
    }
    fetchContext();
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

  return (
    <div className="overflow-y-auto">
      <div className="p-4 md:p-8 max-w-3xl">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="context">Context {contextDirty && <DirtyDot />}</TabsTrigger>
              <TabsTrigger value="profile">Profile {profileDirty && <DirtyDot />}</TabsTrigger>
              <TabsTrigger value="telegram">Telegram</TabsTrigger>
              {isAdmin && (
                <TabsTrigger value="provider">Provider {providerDirty && <DirtyDot />}</TabsTrigger>
              )}
              {isAdmin && <TabsTrigger value="users">Users</TabsTrigger>}
              {isAdmin && <TabsTrigger value="groups">Groups</TabsTrigger>}
              {isAdmin && <TabsTrigger value="license">License</TabsTrigger>}
              {isAdmin && <TabsTrigger value="security">Security</TabsTrigger>}
            </TabsList>
          </div>

          {isAdmin && (
            <TabsContent value="security">
              <SettingsSecurity />
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
              <SettingsGroups refreshKey={enterpriseRefreshKey} />
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
        </Tabs>
      </div>
    </div>
  );
}
