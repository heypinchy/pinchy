"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTabParam, AGENT_SETTINGS_TABS, type AgentSettingsTab } from "@/hooks/use-tab-param";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { AgentSettingsGeneral } from "@/components/agent-settings-general";
import { AgentSettingsFile } from "@/components/agent-settings-file";
import { AgentSettingsPersonality } from "@/components/agent-settings-personality";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";
import { AgentSettingsAccess } from "@/components/agent-settings-access";
import { AgentTelegramSettings } from "@/components/agent-telegram-settings";
import { useRestart } from "@/components/restart-provider";

interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
  allowedTools: string[];
  pluginConfig: { allowed_paths?: string[] } | null;
  tagline: string | null;
  avatarSeed: string | null;
  personalityPresetId: string | null;
  visibility: string;
  groupIds: string[];
}

interface Directory {
  path: string;
  name: string;
}

interface Provider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

interface GeneralValues {
  name: string;
  tagline: string;
  model: string;
}

interface PersonalityValues {
  avatarSeed: string | null;
  presetId: string | null;
  soulContent: string;
}

interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
}

interface AccessValues {
  visibility: string;
  groupIds: string[];
}

type DirtyTabs = Set<"general" | "personality" | "instructions" | "permissions" | "access">;

function DirtyDot() {
  return (
    <span
      className="ml-1 size-1.5 rounded-full bg-amber-500 inline-block"
      aria-label="unsaved changes"
    />
  );
}

export function AgentSettingsPageContent({ initialTab }: { initialTab?: string }) {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const { data: session, isPending } = authClient.useSession();
  const { triggerRestart } = useRestart();
  const isAdmin = session?.user?.role === "admin";
  const visibleTabs: AgentSettingsTab[] =
    isPending || isAdmin ? [...AGENT_SETTINGS_TABS] : ["general", "personality", "instructions"];
  const [activeTab, setActiveTab] = useTabParam("general", visibleTabs, initialTab);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [soulContent, setSoulContent] = useState("");
  const [agentsContent, setAgentsContent] = useState("");
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [loading, setLoading] = useState(true);

  // Accumulated draft values from each tab
  const generalDraft = useRef<GeneralValues | null>(null);
  const personalityDraft = useRef<PersonalityValues | null>(null);
  const instructionsDraft = useRef<string | null>(null);
  const permissionsDraft = useRef<PermissionsValues | null>(null);
  const accessDraft = useRef<AccessValues | null>(null);

  const [dirtyTabs, setDirtyTabs] = useState<DirtyTabs>(new Set());
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showNavWarning, setShowNavWarning] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [agentRes, modelsRes, soulRes, agentsRes, dirRes] = await Promise.all([
        fetch(`/api/agents/${agentId}`),
        fetch("/api/providers/models"),
        fetch(`/api/agents/${agentId}/files/SOUL.md`),
        fetch(`/api/agents/${agentId}/files/AGENTS.md`),
        fetch("/api/data-directories"),
      ]);

      if (agentRes.ok) setAgent(await agentRes.json());
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setProviders(data.providers || []);
      }
      if (soulRes.ok) {
        const data = await soulRes.json();
        setSoulContent(data.content || "");
      }
      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgentsContent(data.content || "");
      }
      if (dirRes.ok) {
        const data = await dirRes.json();
        setDirectories(data.directories || []);
      }
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleGeneralChange = useCallback((values: GeneralValues, isDirty: boolean) => {
    generalDraft.current = values;
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add("general");
      else next.delete("general");
      return next;
    });
  }, []);

  const handlePersonalityChange = useCallback((values: PersonalityValues, isDirty: boolean) => {
    personalityDraft.current = values;
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add("personality");
      else next.delete("personality");
      return next;
    });
  }, []);

  const handleInstructionsChange = useCallback((content: string, isDirty: boolean) => {
    instructionsDraft.current = content;
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add("instructions");
      else next.delete("instructions");
      return next;
    });
  }, []);

  const handlePermissionsChange = useCallback((values: PermissionsValues, isDirty: boolean) => {
    permissionsDraft.current = values;
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add("permissions");
      else next.delete("permissions");
      return next;
    });
  }, []);

  const handleAccessChange = useCallback((values: AccessValues, isDirty: boolean) => {
    accessDraft.current = values;
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (isDirty) next.add("access");
      else next.delete("access");
      return next;
    });
  }, []);

  const needsRestart = dirtyTabs.has("general") || dirtyTabs.has("permissions");
  const hasDirtyTabs = dirtyTabs.size > 0;

  // Warn user before navigating away with unsaved changes
  useEffect(() => {
    if (hasDirtyTabs) {
      window.onbeforeunload = () => true;
    } else {
      window.onbeforeunload = null;
    }
    return () => {
      window.onbeforeunload = null;
    };
  }, [hasDirtyTabs]);

  async function executeSave() {
    setSaving(true);
    setShowConfirmDialog(false);

    try {
      const savePromises: Promise<Response>[] = [];

      // Build unified agent PATCH body
      const agentPatch: Record<string, unknown> = {};
      if (dirtyTabs.has("general") && generalDraft.current) {
        agentPatch.name = generalDraft.current.name;
        agentPatch.tagline = generalDraft.current.tagline;
        agentPatch.model = generalDraft.current.model;
      }
      if (dirtyTabs.has("personality") && personalityDraft.current) {
        agentPatch.avatarSeed = personalityDraft.current.avatarSeed;
        agentPatch.personalityPresetId = personalityDraft.current.presetId;
      }
      if (dirtyTabs.has("permissions") && permissionsDraft.current) {
        agentPatch.allowedTools = permissionsDraft.current.allowedTools;
        agentPatch.pluginConfig = { allowed_paths: permissionsDraft.current.allowedPaths };
      }
      if (dirtyTabs.has("access") && accessDraft.current) {
        agentPatch.visibility = accessDraft.current.visibility;
        agentPatch.groupIds = accessDraft.current.groupIds;
      }

      if (Object.keys(agentPatch).length > 0) {
        savePromises.push(
          fetch(`/api/agents/${agentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(agentPatch),
          })
        );
      }

      if (dirtyTabs.has("personality") && personalityDraft.current) {
        savePromises.push(
          fetch(`/api/agents/${agentId}/files/SOUL.md`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: personalityDraft.current.soulContent }),
          })
        );
      }

      if (dirtyTabs.has("instructions") && instructionsDraft.current !== null) {
        savePromises.push(
          fetch(`/api/agents/${agentId}/files/AGENTS.md`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: instructionsDraft.current }),
          })
        );
      }

      const results = await Promise.all(savePromises);

      if (results.some((r) => !r.ok)) {
        toast.error("Failed to save some settings");
        return;
      }

      toast.success("Settings saved");
      setDirtyTabs(new Set());

      if (needsRestart) {
        triggerRestart();
      }

      router.refresh();
      fetchData();
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  function handleSaveClick() {
    if (needsRestart) {
      setShowConfirmDialog(true);
    } else {
      executeSave();
    }
  }

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }

  if (!agent) {
    return <div className="p-8 text-muted-foreground">Agent not found.</div>;
  }

  const canEdit = isAdmin || agent.isPersonal;
  const canDelete = isAdmin && !agent.isPersonal;
  const showPermissions = isAdmin && !agent.isPersonal;

  // Non-admins cannot edit shared agents — redirect to chat
  if (!canEdit) {
    router.replace(`/chat/${agentId}`);
    return <div className="p-8 text-muted-foreground">Redirecting...</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-2xl">
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => {
              if (hasDirtyTabs) {
                setShowNavWarning(true);
              } else {
                router.push(`/chat/${agentId}`);
              }
            }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back to Chat
          </button>
          <h1 className="text-2xl font-bold">Agent Settings</h1>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="general">
              General {dirtyTabs.has("general") && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="personality">
              Personality {dirtyTabs.has("personality") && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="instructions">
              Instructions {dirtyTabs.has("instructions") && <DirtyDot />}
            </TabsTrigger>
            {showPermissions && (
              <TabsTrigger value="permissions">
                Permissions {dirtyTabs.has("permissions") && <DirtyDot />}
              </TabsTrigger>
            )}
            {showPermissions && (
              <TabsTrigger value="access">
                Access {dirtyTabs.has("access") && <DirtyDot />}
              </TabsTrigger>
            )}
            {isAdmin && <TabsTrigger value="telegram">Telegram</TabsTrigger>}
          </TabsList>

          <TabsContent value="general" keepMounted>
            <AgentSettingsGeneral
              agent={agent}
              providers={providers}
              canDelete={canDelete}
              onChange={handleGeneralChange}
            />
          </TabsContent>

          <TabsContent value="personality" keepMounted>
            <AgentSettingsPersonality
              agentId={agentId}
              agent={{
                avatarSeed: agent.avatarSeed,
                name: agent.name,
                personalityPresetId: agent.personalityPresetId,
              }}
              soulContent={soulContent}
              onChange={handlePersonalityChange}
            />
          </TabsContent>

          <TabsContent value="instructions" keepMounted>
            <AgentSettingsFile
              agentId={agentId}
              filename="AGENTS.md"
              content={agentsContent}
              onChange={handleInstructionsChange}
            />
          </TabsContent>

          {showPermissions && (
            <TabsContent value="permissions" keepMounted>
              <AgentSettingsPermissions
                agent={agent}
                directories={directories}
                onChange={handlePermissionsChange}
              />
            </TabsContent>
          )}

          {showPermissions && (
            <TabsContent value="access" keepMounted>
              <AgentSettingsAccess
                agent={{ visibility: agent.visibility }}
                currentGroupIds={agent.groupIds || []}
                onChange={handleAccessChange}
              />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="telegram">
              <AgentTelegramSettings agentId={agentId} isSmithers={agent.isPersonal} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Save bar — pinned at bottom, outside scroll area */}
      <div className="shrink-0 border-t bg-background px-4 md:px-6 py-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {hasDirtyTabs ? "Unsaved changes" : "All changes saved"}
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={handleSaveClick} disabled={!hasDirtyTabs || saving}>
                {saving ? "Saving..." : needsRestart ? "Save & Restart" : "Save"}
              </Button>
            </TooltipTrigger>
            {needsRestart && (
              <TooltipContent>Will briefly restart the agent runtime</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Confirmation dialog for restart */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply changes and restart?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <span className="block mb-2">Changes to apply:</span>
                <ul className="list-disc list-inside space-y-1">
                  {dirtyTabs.has("general") && <li>General settings (name, model)</li>}
                  {dirtyTabs.has("personality") && <li>Personality (avatar, soul)</li>}
                  {dirtyTabs.has("instructions") && <li>Instructions</li>}
                  {dirtyTabs.has("permissions") && <li>Permissions</li>}
                  {dirtyTabs.has("access") && <li>Access</li>}
                </ul>
                <span className="block mt-3 text-muted-foreground">
                  Active chats will be briefly disconnected.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={executeSave}>Save & Restart</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Navigation warning dialog */}
      <AlertDialog open={showNavWarning} onOpenChange={setShowNavWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. They will be lost if you leave.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => router.push(`/chat/${agentId}`)}>
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
