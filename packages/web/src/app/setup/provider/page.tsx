"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { SmithersModelInfoLine } from "@/components/setup/smithers-model-info-line";
import { useAgentRuntimeReadiness } from "@/hooks/use-agent-runtime-readiness";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";

export default function SetupProviderPage() {
  const router = useRouter();
  const [configuredProvider, setConfiguredProvider] = useState<ProviderName | null>(null);
  const [noVision, setNoVision] = useState(false);
  // Set from the save response. Null means there is nothing to wait for — the
  // regenerate never reached OpenClaw, so no reload is coming (the save's own
  // warning toast covers that case).
  const [runtimeAgentId, setRuntimeAgentId] = useState<string | null>(null);
  const runtime = useAgentRuntimeReadiness(runtimeAgentId);

  function handleSaved(_provider: ProviderName, hasVision: boolean, agentId?: string) {
    setNoVision(!hasVision);
    setRuntimeAgentId(agentId ?? null);
  }

  if (configuredProvider) {
    const defaultModel =
      BALANCED_ANCHORS[configuredProvider] || PROVIDERS[configuredProvider].defaultModel;
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md flex flex-col items-center gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />

          <Card className="w-full">
            <CardHeader className="text-center">
              <div className="flex justify-center mb-2">
                <CheckCircle2 className="size-12 text-primary" />
              </div>
              <CardTitle>Provider connected!</CardTitle>
              <CardDescription>
                Your {PROVIDERS[configuredProvider].name} provider is configured and ready.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <SmithersModelInfoLine modelId={defaultModel} />
              {/*
                The provider is saved; Smithers still has to reach OpenClaw's
                runtime before a chat can be dispatched to him (#1150). That
                step is usually instant and occasionally takes most of a minute
                on a fresh install, so it gets named here instead of being
                hidden inside the save request. `slow` is not a failure — the
                first chat has its own dispatch-race retry behind it — so it
                unlocks the button and says what to expect.
              */}
              {/*
                `role="status"` because the only other cue that the wait ended
                is a disabled attribute coming off a button, which announces
                nothing. The spinner is decorative; the sentence is the status.
              */}
              {runtime === "preparing" && (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                  Getting Smithers ready…
                </p>
              )}
              {runtime === "slow" && (
                <p role="status" className="text-sm text-muted-foreground">
                  Smithers is still catching up. You can continue — your first message may take a
                  moment to land.
                </p>
              )}
              <Button
                onClick={() => router.push("/")}
                className="w-full"
                disabled={runtime === "preparing"}
              >
                Continue to Pinchy
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />

        {noVision && (
          <div className="w-full flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
            <p>
              <strong>No vision-capable model configured.</strong> For full functionality (image
              uploads, scanned PDFs), add Anthropic, OpenAI, or Google as a provider.
            </p>
          </div>
        )}

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Connect your AI provider</CardTitle>
            <CardDescription>
              Choose your AI provider and enter your API key. This is used to power your agents.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProviderKeyForm
              onSuccess={(provider) => {
                if (provider) {
                  setConfiguredProvider(provider);
                } else {
                  router.push("/");
                }
              }}
              onSaved={handleSaved}
              showOpenAiCompatibleOption
              onOpenAiCompatibleSaved={() => router.push("/")}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
