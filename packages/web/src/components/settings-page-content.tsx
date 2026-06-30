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
import { SettingsIntegrations } from "@/components/settings-integrations";

import { SettingsLicense } from "@/components/settings-license";
import { TelegramLinkSettings } from "@/components/telegram-link-settings";
import { SettingsSecurity } from "@/components/settings-security";
import { SecretsProvenanceCard } from "@/components/secrets-provenance-card";
import { SettingsSupport } from "@/components/settings-support";
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
    : ["context", "profile", "telegram", "support"];
  const [activeTab, setActiveTab] = useTabParam("context", visibleTabs, initialTab);

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [userContext, setUserContext] = useState("");
  const [orgContext, setOrgContext] = useState("");
  const [supportAgents, setSupportAgents] = useState<Array<{ id: string; name: string }>>([]);

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

  const fetchSupportAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setSupportAgents(
        list
          .filter(
            (a: { id?: unknown; name?: unknown }) =>
              typeof a?.id === "string" && typeof a?.name === "string"
          )
          .map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }))
      );
    } catch {
      // Best-effort: the Support tab degrades to an empty state.
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
      void fetchSupportAgents();
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, fetchStatus, fetchContext, fetchOrgContext, fetchSupportAgents]);

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
      <div className="p-4 md:p-8 max-w-5xl">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          orientation="vertical"
          className="flex-col md:flex-row"
        >
          <TabsList
            variant="line"
            className="h-fit w-full shrink-0 flex-col items-stretch gap-0.5 md:w-56 md:border-r md:pr-2"
          >
            <div
              role="presentation"
              className="px-2 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Personal
            </div>
            <TabsTrigger value="context" className="w-full justify-start">
              Context {contextDirty && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="profile" className="w-full justify-start">
              Profile {profileDirty && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="telegram" className="w-full justify-start">
              Telegram
            </TabsTrigger>
            <TabsTrigger value="support" className="w-full justify-start">
              Support
            </TabsTrigger>
            {isAdmin && (
              <>
                <div
                  role="presentation"
                  className="px-2 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Administration
                </div>
                <TabsTrigger value="provider" className="w-full justify-start">
                  Provider {providerDirty && <DirtyDot />}
                </TabsTrigger>
                <TabsTrigger value="users" className="w-full justify-start">
                  Users
                </TabsTrigger>
                <TabsTrigger value="groups" className="w-full justify-start">
                  Groups
                </TabsTrigger>
                <TabsTrigger value="integrations" className="w-full justify-start">
                  Integrations
                </TabsTrigger>
                <div
                  role="presentation"
                  className="px-2 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Security &amp; Compliance
                </div>
                <TabsTrigger value="security" className="w-full justify-start">
                  Security
                </TabsTrigger>
                <TabsTrigger value="license" className="w-full justify-start">
                  License
                </TabsTrigger>
              </>
            )}
          </TabsList>

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
            <SettingsSupport agents={supportAgents} />
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
              <SettingsIntegrations />
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
