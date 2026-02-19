"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock } from "lucide-react";

type ProviderName = "anthropic" | "openai" | "google";

const PROVIDERS: Record<ProviderName, { name: string; placeholder: string }> = {
  anthropic: { name: "Anthropic", placeholder: "sk-ant-..." },
  openai: { name: "OpenAI", placeholder: "sk-..." },
  google: { name: "Google", placeholder: "AIza..." },
};

interface ProviderKeyFormProps {
  onSuccess: () => void;
  submitLabel?: string;
}

export function ProviderKeyForm({ onSuccess, submitLabel = "Continue" }: ProviderKeyFormProps) {
  const [provider, setProvider] = useState<ProviderName | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !apiKey.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/setup/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Setup failed");
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && <p className="text-destructive">{error}</p>}

      <div className="space-y-2">
        <Label>Provider</Label>
        <div className="grid grid-cols-3 gap-2">
          {(Object.entries(PROVIDERS) as [ProviderName, typeof PROVIDERS.anthropic][]).map(
            ([key, config]) => (
              <Button
                key={key}
                type="button"
                variant={provider === key ? "default" : "outline"}
                onClick={() => {
                  setProvider(key);
                  setApiKey("");
                  setError("");
                }}
              >
                {config.name}
              </Button>
            )
          )}
        </div>
      </div>

      {provider && (
        <>
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={PROVIDERS[provider].placeholder}
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              Your API key is encrypted at rest and never leaves your server.
            </p>
          </div>

          <Button type="submit" disabled={!apiKey.trim() || loading} className="w-full">
            {loading ? "Validating..." : submitLabel}
          </Button>
        </>
      )}
    </form>
  );
}
