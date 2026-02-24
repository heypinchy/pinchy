"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentSettingsGeneral } from "@/components/agent-settings-general";
import { AgentSettingsFile } from "@/components/agent-settings-file";
import { AgentSettingsPersonality } from "@/components/agent-settings-personality";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";

interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
  allowedTools: string[];
  pluginConfig: { allowed_paths?: string[] } | null;
  tagline: string | null;
  avatarSeed: string | null;
  personalityPresetId: string | null;
}

interface Directory {
  path: string;
  name: string;
}

interface Provider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

export default function AgentSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const { data: session } = useSession();

  const refreshSidebar = useCallback(() => {
    router.refresh();
  }, [router]);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [soulContent, setSoulContent] = useState("");
  const [userContent, setUserContent] = useState("");
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [agentRes, modelsRes, soulRes, userRes, dirRes] = await Promise.all([
          fetch(`/api/agents/${agentId}`),
          fetch("/api/providers/models"),
          fetch(`/api/agents/${agentId}/files/SOUL.md`),
          fetch(`/api/agents/${agentId}/files/USER.md`),
          fetch("/api/data-directories"),
        ]);

        if (agentRes.ok) {
          setAgent(await agentRes.json());
        }

        if (modelsRes.ok) {
          const data = await modelsRes.json();
          setProviders(data.providers || []);
        }

        if (soulRes.ok) {
          const data = await soulRes.json();
          setSoulContent(data.content || "");
        }

        if (userRes.ok) {
          const data = await userRes.json();
          setUserContent(data.content || "");
        }

        if (dirRes.ok) {
          const data = await dirRes.json();
          setDirectories(data.directories || []);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [agentId]);

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }

  if (!agent) {
    return <div className="p-8 text-muted-foreground">Agent not found.</div>;
  }

  const isAdmin = session?.user?.role === "admin";
  const canDelete = isAdmin && !agent.isPersonal;
  const showPermissions = isAdmin && !agent.isPersonal;

  return (
    <div className="overflow-y-auto p-8 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <Link
          href={`/chat/${agentId}`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Back to Chat
        </Link>
        <h1 className="text-2xl font-bold">Agent Settings</h1>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="personality">Personality</TabsTrigger>
          <TabsTrigger value="user">USER.md</TabsTrigger>
          {showPermissions && <TabsTrigger value="permissions">Permissions</TabsTrigger>}
        </TabsList>

        <TabsContent value="general">
          <AgentSettingsGeneral
            agent={{
              id: agent.id,
              name: agent.name,
              model: agent.model,
              isPersonal: agent.isPersonal,
              tagline: agent.tagline,
            }}
            providers={providers}
            canDelete={canDelete}
            onSaved={refreshSidebar}
          />
        </TabsContent>

        <TabsContent value="personality">
          <AgentSettingsPersonality
            agentId={agentId}
            agent={{
              avatarSeed: agent.avatarSeed,
              name: agent.name,
              personalityPresetId: agent.personalityPresetId,
            }}
            soulContent={soulContent}
            onSaved={refreshSidebar}
          />
        </TabsContent>

        <TabsContent value="user">
          <AgentSettingsFile agentId={agentId} filename="USER.md" content={userContent} />
        </TabsContent>

        {showPermissions && (
          <TabsContent value="permissions">
            <AgentSettingsPermissions agent={agent} directories={directories} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
