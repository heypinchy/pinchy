"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function AgentSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const [agent, setAgent] = useState({ name: "", model: "", systemPrompt: "" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/agents/${params.agentId}`)
      .then((r) => r.json())
      .then(setAgent)
      .finally(() => setLoading(false));
  }, [params.agentId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/agents/${params.agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    router.push(`/chat/${params.agentId}`);
  }

  if (loading) return <div className="p-8 text-muted-foreground">Laden...</div>;

  return (
    <div className="p-8 max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Agent Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={agent.name}
                onChange={(e) => setAgent({ ...agent, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={agent.model}
                onChange={(e) => setAgent({ ...agent, model: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt">System Prompt</Label>
              <Textarea
                id="prompt"
                value={agent.systemPrompt || ""}
                onChange={(e) => setAgent({ ...agent, systemPrompt: e.target.value })}
                rows={5}
              />
            </div>
            <Button type="submit">
              Speichern
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
