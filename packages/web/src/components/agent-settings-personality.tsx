"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { getAgentAvatarSvg, generateAvatarSeed } from "@/lib/avatar";
import { PERSONALITY_PRESETS, getPersonalityPreset } from "@/lib/personality-presets";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dices, ChevronRight } from "lucide-react";

interface AgentSettingsPersonalityProps {
  agentId: string;
  agent: {
    avatarSeed: string | null;
    name: string;
    personalityPresetId: string | null;
  };
  soulContent: string;
  onSaved?: () => void;
}

export function AgentSettingsPersonality({
  agentId,
  agent,
  soulContent,
  onSaved,
}: AgentSettingsPersonalityProps) {
  const [avatarSeed, setAvatarSeed] = useState(agent.avatarSeed);
  const [presetId, setPresetId] = useState<string | null>(agent.personalityPresetId);
  const [content, setContent] = useState(soulContent);
  const [pendingPresetId, setPendingPresetId] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  const avatarUrl = getAgentAvatarSvg({
    avatarSeed,
    name: agent.name,
  });

  function handleReRoll() {
    setAvatarSeed(generateAvatarSeed());
  }

  function handlePresetClick(id: string) {
    if (id === presetId) return;

    const preset = getPersonalityPreset(id);
    if (!preset) return;

    // If content matches the target preset, switch directly
    if (content === preset.soulMd) {
      setPresetId(id);
      return;
    }

    setPendingPresetId(id);
    setShowConfirm(true);
  }

  function handleConfirmSwitch() {
    if (!pendingPresetId) return;
    const preset = getPersonalityPreset(pendingPresetId);
    if (!preset) return;

    setContent(preset.soulMd);
    setPresetId(pendingPresetId);
    setPendingPresetId(null);
    setShowConfirm(false);
  }

  function handleCancelSwitch() {
    setPendingPresetId(null);
    setShowConfirm(false);
  }

  function handleContentChange(newContent: string) {
    setContent(newContent);

    // Check if content still matches the active preset
    if (presetId) {
      const preset = getPersonalityPreset(presetId);
      if (preset && newContent !== preset.soulMd) {
        setPresetId(null);
      }
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const [patchRes, putRes] = await Promise.all([
        fetch(`/api/agents/${agentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            avatarSeed,
            personalityPresetId: presetId,
          }),
        }),
        fetch(`/api/agents/${agentId}/files/SOUL.md`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      ]);

      if (!patchRes.ok || !putRes.ok) {
        toast.error("Failed to save personality settings");
        return;
      }

      toast.success("Personality settings saved");
      onSaved?.();
    } catch {
      toast.error("Failed to save personality settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl} alt="" className="size-16 rounded-full" />
        {agent.avatarSeed !== "__smithers__" && (
          <Button variant="outline" size="sm" onClick={handleReRoll}>
            <Dices className="size-4 mr-2" />
            Re-roll
          </Button>
        )}
      </div>

      {/* Personality Preset Picker */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Personality Preset</h3>
          {presetId === null && <Badge variant="secondary">Customized</Badge>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {Object.values(PERSONALITY_PRESETS).map((preset) => (
            <Card
              key={preset.id}
              className={`cursor-pointer transition-colors ${
                presetId === preset.id
                  ? "border-primary bg-primary/5"
                  : "hover:border-muted-foreground/50"
              }`}
              onClick={() => handlePresetClick(preset.id)}
            >
              <CardContent className="p-3">
                <p className="font-medium text-sm">{preset.name}</p>
                <p className="text-xs text-muted-foreground">{preset.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* SOUL.md Editor (collapsible) */}
      <Collapsible open={showEditor} onOpenChange={setShowEditor}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-medium hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={`size-4 transition-transform ${showEditor ? "rotate-90" : ""}`}
            />
            Customize
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 pt-2">
            <p className="text-sm text-muted-foreground">
              Defines your agent&apos;s personality — tone, style, and character. The presets above
              fill in sensible defaults, but you can edit the text below to fine-tune exactly how
              your agent communicates.
            </p>
            <MarkdownEditor
              value={content}
              onChange={handleContentChange}
              className="min-h-[300px]"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Save */}
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save & restart"}
      </Button>

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch Personality</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace your current personality text. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelSwitch}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSwitch}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
