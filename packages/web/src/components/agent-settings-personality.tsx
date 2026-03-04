"use client";

import { useState, useEffect, useRef } from "react";
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
  onChange: (
    values: { avatarSeed: string | null; presetId: string | null; soulContent: string },
    isDirty: boolean
  ) => void;
}

export function AgentSettingsPersonality({
  agentId: _agentId,
  agent,
  soulContent,
  onChange,
}: AgentSettingsPersonalityProps) {
  const [avatarSeed, setAvatarSeed] = useState(agent.avatarSeed);
  const [presetId, setPresetId] = useState<string | null>(agent.personalityPresetId);
  const [content, setContent] = useState(soulContent);
  const [pendingPresetId, setPendingPresetId] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  const initialValues = useRef({
    avatarSeed: agent.avatarSeed,
    presetId: agent.personalityPresetId,
    soulContent,
  });

  const avatarUrl = getAgentAvatarSvg({
    avatarSeed,
    name: agent.name,
  });

  function notifyChange(
    newAvatarSeed: string | null,
    newPresetId: string | null,
    newContent: string
  ) {
    const isDirty =
      newAvatarSeed !== initialValues.current.avatarSeed ||
      newPresetId !== initialValues.current.presetId ||
      newContent !== initialValues.current.soulContent;
    onChange(
      { avatarSeed: newAvatarSeed, presetId: newPresetId, soulContent: newContent },
      isDirty
    );
  }

  // Notify on mount with isDirty=false
  useEffect(() => {
    notifyChange(avatarSeed, presetId, content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleReRoll() {
    const newSeed = generateAvatarSeed();
    setAvatarSeed(newSeed);
    notifyChange(newSeed, presetId, content);
  }

  function handlePresetClick(id: string) {
    if (id === presetId) return;

    const preset = getPersonalityPreset(id);
    if (!preset) return;

    // If content matches the target preset, switch directly
    if (content === preset.soulMd) {
      setPresetId(id);
      notifyChange(avatarSeed, id, content);
      return;
    }

    setPendingPresetId(id);
    setShowConfirm(true);
  }

  function handleConfirmSwitch() {
    if (!pendingPresetId) return;
    const preset = getPersonalityPreset(pendingPresetId);
    if (!preset) return;

    const newContent = preset.soulMd;
    const newPresetId = pendingPresetId;

    setContent(newContent);
    setPresetId(newPresetId);
    setPendingPresetId(null);
    setShowConfirm(false);
    notifyChange(avatarSeed, newPresetId, newContent);
  }

  function handleCancelSwitch() {
    setPendingPresetId(null);
    setShowConfirm(false);
  }

  function handleContentChange(newContent: string) {
    setContent(newContent);

    // Check if content still matches the active preset
    let newPresetId = presetId;
    if (presetId) {
      const preset = getPersonalityPreset(presetId);
      if (preset && newContent !== preset.soulMd) {
        setPresetId(null);
        newPresetId = null;
      }
    }
    notifyChange(avatarSeed, newPresetId, newContent);
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
