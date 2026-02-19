"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Lock, ChevronDown, ExternalLink, CircleCheck, CircleX } from "lucide-react";

type ProviderName = "anthropic" | "openai" | "google";

interface ProviderStep {
  label: string;
  optional?: boolean;
  link?: { text: string; url: string };
}

interface ProviderGuide {
  keyUrl: string;
  steps: ProviderStep[];
}

const PROVIDERS: Record<
  ProviderName,
  { name: string; placeholder: string; prefix: string; guide: ProviderGuide }
> = {
  anthropic: {
    name: "Anthropic",
    placeholder: "sk-ant-...",
    prefix: "sk-ant-",
    guide: {
      keyUrl: "https://platform.claude.com/settings/keys",
      steps: [
        {
          label: "Sign up at platform.claude.com",
          optional: true,
          link: { text: "platform.claude.com", url: "https://platform.claude.com" },
        },
        { label: "Open API Keys in the left sidebar" },
        { label: "Click Create Key and copy it immediately" },
        { label: "Add a payment method under Plans & Billing", optional: true },
      ],
    },
  },
  openai: {
    name: "OpenAI",
    placeholder: "sk-...",
    prefix: "sk-",
    guide: {
      keyUrl: "https://platform.openai.com/api-keys",
      steps: [
        {
          label: "Sign up at platform.openai.com",
          optional: true,
          link: { text: "platform.openai.com", url: "https://platform.openai.com" },
        },
        { label: "Open API Keys in the left sidebar" },
        { label: "Click Create new secret key and copy it immediately" },
        { label: "Add a payment method under Billing", optional: true },
      ],
    },
  },
  google: {
    name: "Google",
    placeholder: "AIza...",
    prefix: "AIza",
    guide: {
      keyUrl: "https://aistudio.google.com/apikey",
      steps: [
        {
          label: "Sign in with your Google account at aistudio.google.com",
          optional: true,
          link: { text: "aistudio.google.com", url: "https://aistudio.google.com" },
        },
        { label: "Click Get API key in the left sidebar" },
        { label: "Click Create API key and copy it" },
      ],
    },
  },
};

function renderStepWithLink(label: string, link: { text: string; url: string }) {
  const index = label.indexOf(link.text);
  if (index === -1) return label;
  const before = label.slice(0, index);
  const after = label.slice(index + link.text.length);
  return (
    <>
      {before}
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {link.text}
      </a>
      {after}
    </>
  );
}

interface ProviderKeyFormProps {
  onSuccess: () => void;
  submitLabel?: string;
  configuredProviders?: Record<string, { configured: boolean; hint?: string }>;
  defaultProvider?: string | null;
}

export function ProviderKeyForm({
  onSuccess,
  submitLabel = "Continue",
  configuredProviders,
  defaultProvider,
}: ProviderKeyFormProps) {
  const [provider, setProvider] = useState<ProviderName | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);

  const isConfigured = provider ? configuredProviders?.[provider]?.configured === true : false;
  const hint = provider ? configuredProviders?.[provider]?.hint : undefined;
  const maskedPlaceholder =
    provider && isConfigured && hint
      ? `${PROVIDERS[provider].prefix}····${hint}`
      : provider
        ? PROVIDERS[provider].placeholder
        : "";

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
        let message = "Setup failed";
        try {
          const data = await res.json();
          if (data.error) message = data.error;
        } catch {
          // response body was not JSON; use default message
        }
        throw new Error(message);
      }

      setSaved(true);
      setApiKey("");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label>Provider</Label>
        <div className="grid grid-cols-3 gap-2">
          {(Object.entries(PROVIDERS) as [ProviderName, (typeof PROVIDERS)[ProviderName]][]).map(
            ([key, config]) => (
              <div key={key} className="flex flex-col items-center gap-1">
                <Button
                  type="button"
                  variant={provider === key ? "default" : "outline"}
                  className="w-full"
                  onClick={() => {
                    setProvider(key);
                    setApiKey("");
                    setError("");
                    setGuideOpen(false);
                    setSaved(false);
                  }}
                >
                  {config.name}
                </Button>
                {configuredProviders?.[key]?.configured && (
                  <span className="text-xs text-muted-foreground">
                    {defaultProvider === key ? "Active" : "Configured"}
                  </span>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {provider && (
        <>
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={maskedPlaceholder}
                className="flex-1"
              />
              {error && !loading && (
                <CircleX
                  className="size-5 text-destructive shrink-0"
                  data-testid="key-error-indicator"
                />
              )}
              {!error && (isConfigured || saved) && !loading && (
                <CircleCheck
                  className="size-5 text-green-600 shrink-0"
                  data-testid="key-configured-indicator"
                />
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              Your API key is encrypted at rest and never leaves your server.
            </p>
          </div>

          <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <ChevronDown
                className={`size-4 transition-transform ${guideOpen ? "rotate-180" : ""}`}
              />
              Need help getting a key?
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 space-y-3 rounded-md border p-3 text-sm">
                <ol className="space-y-1.5 list-decimal list-inside text-muted-foreground">
                  {PROVIDERS[provider].guide.steps.map((step) => (
                    <li key={step.label}>
                      {step.link ? renderStepWithLink(step.label, step.link) : step.label}
                      {step.optional && (
                        <span className="text-xs text-muted-foreground/60"> (optional)</span>
                      )}
                    </li>
                  ))}
                </ol>
                <a
                  href={PROVIDERS[provider].guide.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  Go to {PROVIDERS[provider].name}
                  <ExternalLink className="size-3" />
                </a>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Button type="submit" disabled={!apiKey.trim() || loading} className="w-full">
            {loading ? "Validating..." : configuredProviders ? "Save" : submitLabel}
          </Button>

          {configuredProviders && isConfigured && (
            <Button
              type="button"
              variant="ghost"
              className="w-full text-destructive hover:text-destructive"
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                setError("");
                try {
                  const res = await fetch("/api/settings/providers", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider }),
                  });
                  if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || "Failed to remove key");
                  }
                  onSuccess();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Failed to remove key");
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {removing ? "Removing..." : "Remove key"}
            </Button>
          )}
        </>
      )}
    </form>
  );
}
