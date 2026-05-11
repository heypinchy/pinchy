"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { SmithersModelInfoLine } from "@/components/setup/smithers-model-info-line";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";

export default function SetupProviderPage() {
  const router = useRouter();
  const [configuredProvider, setConfiguredProvider] = useState<ProviderName | null>(null);
  const [noVision, setNoVision] = useState(false);

  function handleSaved(_provider: ProviderName, hasVision: boolean) {
    setNoVision(!hasVision);
  }

  if (configuredProvider) {
    const defaultModel =
      BALANCED_ANCHORS[configuredProvider] || PROVIDERS[configuredProvider].defaultModel;
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md flex flex-col items-center gap-6">
          <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />

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
              <Button onClick={() => router.push("/")} className="w-full">
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
        <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />

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
              Choose your LLM provider and enter your API key. This is used to power your agents.
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
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
