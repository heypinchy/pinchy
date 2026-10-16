"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiPut, errorMessage } from "@/lib/api-client";
import type { IndexScheduleStatus } from "@/lib/knowledge/index-schedule";
import type { KnowledgeIndexScheduleRequest } from "@/lib/schemas/knowledge-base";

const URL = "/api/settings/knowledge-index-schedule";

/**
 * The nightly knowledge-base reindex, instance-wide: on or off, and at what
 * time in the org timezone. Sits on the Organization tab beside the timezone
 * it is read in.
 *
 * On by default, so most admins never touch this — the card exists to say
 * when it runs, to move it out of somebody's backup window, and to switch it
 * off where nightly OCR of new scans is not wanted.
 */
export function KnowledgeIndexScheduleSettings() {
  const [status, setStatus] = useState<IndexScheduleStatus | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState("02:00");
  const [saving, setSaving] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<IndexScheduleStatus>(URL)
      .then((loaded) => {
        if (cancelled) return;
        setStatus(loaded);
        setEnabled(loaded.enabled);
        setTime(loaded.time);
      })
      .catch(() => {
        // Non-critical: without a status there is nothing true to show, so the
        // card stays out of the way rather than rendering a guessed default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setTimeError(null);
    try {
      const saved = await apiPut<IndexScheduleStatus, KnowledgeIndexScheduleRequest>(URL, {
        enabled,
        time,
      });
      setStatus(saved);
      toast.success("Settings saved");
    } catch (e) {
      // A rejected time is the admin's to fix, so it goes next to the field.
      const fieldError =
        e instanceof ApiError
          ? (e.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors
              ?.time?.[0]
          : undefined;
      if (fieldError) setTimeError(fieldError);
      else toast.error(errorMessage(e, "Failed to save the reindex schedule"));
    } finally {
      setSaving(false);
    }
  }

  if (!status) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge Base Indexing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Pinchy reindexes every knowledge-base agent once a night, so documents added to, changed
          in or removed from their folders during the day are reflected the next morning. Only what
          changed is read again.
        </p>

        <div className="flex items-center gap-2">
          <Checkbox
            id="kb-index-enabled"
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <Label htmlFor="kb-index-enabled">Reindex every night</Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kb-index-time">Time ({status.timezone})</Label>
          <Input
            id="kb-index-time"
            type="time"
            className="w-full max-w-[10rem]"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={!enabled}
            aria-invalid={timeError !== null}
          />
          {timeError && <p className="text-sm text-destructive">{timeError}</p>}
        </div>

        <ScheduleSummary status={status} />

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ScheduleSummary({ status }: { status: IndexScheduleStatus }) {
  const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        {status.nextRun
          ? `Next run: ${status.nextRun.day} at ${status.nextRun.time} (${status.timezone}).`
          : "Off. New documents show up only when an admin reindexes an agent."}
      </p>
      {status.currentSweep && (
        <p>
          Tonight&apos;s run is under way: {status.currentSweep.waiting} of{" "}
          {agents(status.currentSweep.agentCount)} are still waiting their turn.
        </p>
      )}
      {status.lastSweep && (
        <p>
          Last nightly run: {status.lastSweep.slot}, {agents(status.lastSweep.agentCount)}. Each
          agent&apos;s Permissions tab shows how its run went.
        </p>
      )}
    </div>
  );
}
