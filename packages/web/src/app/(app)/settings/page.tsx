"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "anthropic_api_key", value: apiKey }),
    });
    setSaved(true);
    setApiKey("");
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>LLM Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="apiKey">Anthropic API Key</Label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
              />
            </div>
            <Button onClick={handleSave}>
              Speichern
            </Button>
            {saved && <p className="text-green-600">Gespeichert!</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
