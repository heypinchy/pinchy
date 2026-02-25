"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsContext } from "@/components/settings-context";
import { SettingsProfile } from "@/components/settings-profile";

interface ProviderStatus {
  defaultProvider: string | null;
  providers: Record<string, { configured: boolean }>;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [userContext, setUserContext] = useState("");
  const [orgContext, setOrgContext] = useState("");

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

  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <Tabs defaultValue={isAdmin ? "provider" : "context"}>
        <TabsList>
          {isAdmin && <TabsTrigger value="provider">Provider</TabsTrigger>}
          {isAdmin && <TabsTrigger value="users">Users</TabsTrigger>}
          <TabsTrigger value="context">Context</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        {isAdmin && (
          <TabsContent value="provider">
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
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="users">
            <SettingsUsers currentUserId={session?.user?.id ?? ""} />
          </TabsContent>
        )}

        <TabsContent value="context">
          <SettingsContext userContext={userContext} orgContext={orgContext} isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="profile">
          <SettingsProfile userName={session?.user?.name ?? ""} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
