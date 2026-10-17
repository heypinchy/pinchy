"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { apiGet, apiPut, errorMessage } from "@/lib/api-client";
import type { InstancePolicyInput } from "@/lib/schemas/governance";

/**
 * Settings → Organization → Member access: the two switches that keep a
 * flat-priced instance from turning into an open-ended one. Off pauses and
 * hides; nothing is deleted, and admins are never affected.
 */
export function MemberAccessSettings() {
  const [policy, setPolicy] = useState<InstancePolicyInput | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<InstancePolicyInput>("/api/settings/governance")
      .then(setPolicy)
      // A system error, not a field the admin could correct — a toast
      // (AGENTS.md § "Error And Notification UI"), and the card stays away.
      .catch((e) => toast.error(errorMessage(e, "Couldn't load member access settings")));
  }, []);

  async function handleSave() {
    if (!policy) return;
    setSaving(true);
    try {
      setPolicy(
        await apiPut<InstancePolicyInput, InstancePolicyInput>("/api/settings/governance", policy)
      );
      toast.success("Member access saved");
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save member access settings"));
    } finally {
      setSaving(false);
    }
  }

  if (!policy) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Member access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Decide what members can do on their own. Turning something off pauses it — nothing is
          deleted, and turning it back on restores everything as it was. Admins are never affected.
        </p>

        <div className="flex items-start gap-3">
          <Checkbox
            id="policy-personal-agents"
            checked={policy.memberPersonalAgents}
            onCheckedChange={(checked) =>
              setPolicy({ ...policy, memberPersonalAgents: checked === true })
            }
          />
          <div className="space-y-1">
            <Label htmlFor="policy-personal-agents">
              Members can use a personal agent (Smithers)
            </Label>
            <p className="text-sm text-muted-foreground">
              When off, members only see the shared agents you give them, on the web and in
              Telegram.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Checkbox
            id="policy-automations"
            checked={policy.memberPersonalAgents && policy.memberAutomations}
            disabled={!policy.memberPersonalAgents}
            onCheckedChange={(checked) =>
              setPolicy({ ...policy, memberAutomations: checked === true })
            }
          />
          <div className="space-y-1">
            <Label htmlFor="policy-automations">
              Members can create automations on their personal agent
            </Label>
            <p className="text-sm text-muted-foreground">
              Automations run on their own, on every matching email. When off, existing ones are
              paused until you turn this back on.
            </p>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
