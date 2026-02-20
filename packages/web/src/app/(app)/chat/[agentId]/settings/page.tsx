"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentSettingsGeneral } from "@/components/agent-settings-general";
import { AgentSettingsFile } from "@/components/agent-settings-file";

interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
}

interface Provider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

export default function AgentSettingsPage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const { data: session } = useSession();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [soulContent, setSoulContent] = useState("");
  const [userContent, setUserContent] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [agentRes, modelsRes, soulRes, userRes] = await Promise.all([
          fetch(`/api/agents/${agentId}`),
          fetch("/api/providers/models"),
          fetch(`/api/agents/${agentId}/files/SOUL.md`),
          fetch(`/api/agents/${agentId}/files/USER.md`),
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

  const canDelete = session?.user?.role === "admin" && !agent.isPersonal;

  return (
    <div className="p-8 max-w-2xl">
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
          <TabsTrigger value="soul">SOUL.md</TabsTrigger>
          <TabsTrigger value="user">USER.md</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <AgentSettingsGeneral agent={agent} providers={providers} canDelete={canDelete} />
        </TabsContent>

        <TabsContent value="soul">
          <AgentSettingsFile agentId={agentId} filename="SOUL.md" content={soulContent} />
        </TabsContent>

        <TabsContent value="user">
          <AgentSettingsFile agentId={agentId} filename="USER.md" content={userContent} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
