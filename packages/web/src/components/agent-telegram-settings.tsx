"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CircleCheck, ChevronDown, Lock } from "lucide-react";
import { useRestart } from "@/components/restart-provider";

interface TelegramConfig {
  configured: boolean;
  hint?: string;
  botUsername?: string;
}

interface AgentTelegramSettingsProps {
  agentId: string;
  onConnected?: () => void;
  /** Render without Card wrapper (for embedding in an existing Card) */
  bare?: boolean;
  /** Smithers' bot cannot be individually disconnected */
  isSmithers?: boolean;
}

export function AgentTelegramSettings({
  agentId,
  onConnected,
  bare,
  isSmithers,
}: AgentTelegramSettingsProps) {
  const { triggerRestart } = useRestart();
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [connectedUsername, setConnectedUsername] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/channels/telegram`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch {
      setConfig({ configured: false });
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleConnect() {
    if (!botToken.trim()) return;

    setSaving(true);
    setError("");

    try {
      const res = await fetch(`/api/agents/${agentId}/channels/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken }),
      });

      if (!res.ok) {
        let message = "Failed to connect";
        try {
          const data = await res.json();
          if (data.error) message = data.error;
        } catch {
          // response body was not JSON
        }
        throw new Error(message);
      }

      const data = await res.json();
      setConnectedUsername(data.botUsername || null);
      setBotToken("");
      triggerRestart();
      toast.success("Telegram bot connected");
      fetchConfig();
      onConnected?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setRemoving(true);
    setError("");

    try {
      const res = await fetch(`/api/agents/${agentId}/channels/telegram`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to disconnect");
      }

      setConnectedUsername(null);
      triggerRestart();
      toast.success("Telegram bot disconnected");
      fetchConfig();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setRemoving(false);
    }
  }

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading...</div>;
  }

  const isConfigured = config?.configured === true;

  const content = (
    <div className="space-y-4">
      {isConfigured ? (
        <>
          <div className="flex items-center gap-2">
            <CircleCheck className="size-5 text-green-600 shrink-0" />
            <span className="text-sm font-medium">Connected</span>
            {connectedUsername && <Badge variant="secondary">@{connectedUsername}</Badge>}
          </div>
          {config?.hint && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              Token ending in ····{config.hint}
            </p>
          )}
          {isSmithers ? (
            <p className="text-xs text-muted-foreground">
              To disconnect this bot, use &quot;Remove Telegram for everyone&quot; in Settings.
            </p>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={removing}
                >
                  {removing ? "Disconnecting..." : "Disconnect"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect Telegram bot?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the Telegram bot connection for this agent. Users will no
                    longer be able to chat with the agent via Telegram.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={handleDisconnect}>
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Create a Telegram bot for this agent. Pick a name your team will recognize. The bot name
            must be unique and can&apos;t be changed later.
          </p>

          <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <ChevronDown
                className={`size-4 transition-transform ${guideOpen ? "rotate-180" : ""}`}
              />
              How to create a Telegram bot
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 space-y-3 rounded-md border p-3 text-sm">
                <p className="text-muted-foreground">
                  Tip: Use{" "}
                  <a
                    href="https://web.telegram.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Telegram Web
                  </a>{" "}
                  or the desktop app to easily copy the token.
                </p>
                <ol className="space-y-1.5 list-decimal list-inside text-muted-foreground">
                  <li>
                    Open{" "}
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      @BotFather
                    </a>{" "}
                    in Telegram
                  </li>
                  <li>
                    Send <code className="bg-muted px-1 rounded">/newbot</code>
                  </li>
                  <li>Choose a display name</li>
                  <li>
                    Choose a username ending in <code className="bg-muted px-1 rounded">bot</code>
                  </li>
                  <li>Copy the token BotFather gives you</li>
                </ol>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="space-y-2">
            <Label htmlFor="telegram-bot-token">Bot Token</Label>
            <Input
              id="telegram-bot-token"
              type="password"
              placeholder="Paste your bot token here"
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleConnect();
                }
              }}
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              Your bot token is encrypted at rest and never leaves your server.
            </p>
          </div>

          {connectedUsername && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CircleCheck className="size-4" />
              Connected to @{connectedUsername}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleConnect} disabled={!botToken.trim() || saving}>
            {saving ? "Connecting..." : "Connect"}
          </Button>
        </>
      )}
    </div>
  );

  if (bare) return content;

  return (
    <div className="space-y-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>
            Connect a Telegram bot so users can chat with this agent directly in Telegram.
          </CardDescription>
        </CardHeader>
        <CardContent>{content}</CardContent>
      </Card>
    </div>
  );
}
