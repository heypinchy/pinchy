"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { IntegrationTypePicker } from "./integration-type-picker";
import { AddIntegrationDialog } from "./add-integration-dialog";
import type { IntegrationTypeId } from "./integration-types";
import type { IntegrationConnection } from "@/lib/integrations/types";

const SETTINGS_INTEGRATIONS_HREF = "/settings?tab=integrations";

/**
 * Dedicated integration-picker page. Renders a grid of integration tiles and
 * opens the existing AddIntegrationDialog (with the chosen type pre-selected)
 * as an overlay. On success, navigates back to the settings integrations tab.
 *
 * The dialog handles the entire per-type connect flow — this page is purely
 * the type-picker step.
 */
export function NewIntegrationContent() {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<IntegrationTypeId | null>(null);
  const [configuredSingletons, setConfiguredSingletons] = useState<string[]>([]);

  // Load existing connections so singleton tiles (e.g. Web Search) render
  // disabled when one is already configured. Failure is silently ignored —
  // the worst-case is that the user gets a 4xx after submitting the form.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: IntegrationConnection[]) => {
        if (cancelled) return;
        setConfiguredSingletons(data.map((c) => c.type));
      })
      .catch(() => {
        // Non-fatal — the form still works without singleton hints.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleDialogChange(open: boolean) {
    if (!open) setSelectedType(null);
  }

  function handleSuccess() {
    router.push(SETTINGS_INTEGRATIONS_HREF);
    router.refresh();
  }

  return (
    <div className="container mx-auto max-w-4xl py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="Back to settings">
          <Link href={SETTINGS_INTEGRATIONS_HREF}>
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">Add Integration</h1>
          <p className="text-sm text-muted-foreground">
            Choose an integration to connect to an external system.
          </p>
        </div>
      </div>

      <IntegrationTypePicker
        configuredSingletons={configuredSingletons}
        onSelect={setSelectedType}
      />

      {selectedType && (
        <AddIntegrationDialog
          open={true}
          onOpenChange={handleDialogChange}
          onSuccess={handleSuccess}
          existingTypes={configuredSingletons}
          initialType={selectedType}
        />
      )}
    </div>
  );
}
