"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderKeyForm } from "@/components/provider-key-form";

export default function SetupProviderPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Connect your AI provider</CardTitle>
            <CardDescription>
              Choose your LLM provider and enter your API key. This is used to power your agents.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProviderKeyForm onSuccess={() => router.push("/")} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
