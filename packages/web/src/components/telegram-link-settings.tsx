"use client";

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ExternalLink, Lock, CircleCheck } from "lucide-react";

interface TelegramLinkStatus {
  linked: boolean;
  channelUserId?: string;
}

interface TelegramBot {
  agentId: string;
  agentName: string;
  botUsername: string;
}

interface TelegramLinkSettingsProps {
  isAdmin: boolean;
}

export function TelegramLinkSettings({ isAdmin }: TelegramLinkSettingsProps) {
  const [linkStatus, setLinkStatus] = useState<TelegramLinkStatus | null>(null);
  const [bots, setBots] = useState<TelegramBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Inline setup state (admin only)
  const [showSetup, setShowSetup] = useState(false);
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [smithersId, setSmithersId] = useState<string | null>(null);
  const [connectedBotName, setConnectedBotName] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [linkRes, botsRes] = await Promise.all([
        fetch("/api/settings/telegram"),
        fetch("/api/settings/telegram/bots"),
      ]);

      if (linkRes.ok) {
        setLinkStatus(await linkRes.json());
      } else {
        setLinkStatus({ linked: false });
      }

      if (botsRes.ok) {
        const data = await botsRes.json();
        setBots(data.bots || []);
      }
    } catch {
      setLinkStatus({ linked: false });
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch Smithers ID for inline setup
  useEffect(() => {
    if (isAdmin) {
      fetch("/api/agents")
        .then((res) => {
          if (!res.ok) return [];
          return res.json();
        })
        .then((data) => {
          const agents = Array.isArray(data) ? data : [];
          const smithers = agents.find((a: { isPersonal: boolean }) => !a.isPersonal);
          if (smithers) setSmithersId(smithers.id);
        })
        .catch(() => {});
    }
  }, [isAdmin]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleLink() {
    if (!code.trim()) return;

    setLinking(true);
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });

      if (res.ok) {
        toast.success("Telegram account linked");
        setCode("");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to link Telegram account");
      }
    } catch {
      toast.error("Failed to link Telegram account");
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink() {
    setUnlinking(true);
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "DELETE",
      });

      if (res.ok) {
        toast.success("Telegram account unlinked");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to unlink Telegram account");
      }
    } catch {
      toast.error("Failed to unlink Telegram account");
    } finally {
      setUnlinking(false);
    }
  }

  async function handleSetupConnect() {
    if (!botToken.trim()) return;
    if (!smithersId) {
      setSetupError("Could not find Smithers. Please reload the page and try again.");
      return;
    }

    setSaving(true);
    setSetupError("");

    try {
      const res = await fetch(`/api/agents/${smithersId}/channels/telegram`, {
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
          // not JSON
        }
        throw new Error(message);
      }

      const data = await res.json();
      setConnectedBotName(data.botUsername || null);
      setBotToken("");
      setShowSetup(false);
      toast.success("Telegram connected to Smithers");
      await fetchData();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  // State 3: User is linked
  if (linkStatus?.linked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>Your Telegram account is connected.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CircleCheck className="size-5 text-green-600 shrink-0" />
              <Badge className="bg-green-600 text-white">Linked</Badge>
            </div>
            <Button variant="outline" onClick={handleUnlink} disabled={unlinking}>
              {unlinking ? "Unlinking..." : "Unlink Telegram account"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasBots = bots.length > 0;
  const primaryBot = bots[0];

  // State 1: No bots configured
  if (!hasBots) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>Chat with your agents directly in Telegram.</CardDescription>
        </CardHeader>
        <CardContent>
          {isAdmin ? (
            <div className="space-y-4">
              {!showSetup ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Set up Telegram so your team can chat with agents from their phone. Once
                    enabled, all team members can link their Telegram account.
                  </p>
                  <Button onClick={() => setShowSetup(true)}>Set up Telegram</Button>
                </>
              ) : (
                <InlineSetup
                  guideOpen={setupGuideOpen}
                  onGuideOpenChange={setSetupGuideOpen}
                  botToken={botToken}
                  onBotTokenChange={(v) => {
                    setBotToken(v);
                    setSetupError("");
                  }}
                  error={setupError}
                  saving={saving}
                  connectedBotName={connectedBotName}
                  onConnect={handleSetupConnect}
                  onCancel={() => {
                    setShowSetup(false);
                    setBotToken("");
                    setSetupError("");
                  }}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Telegram isn&apos;t set up yet. Ask your administrator to enable it.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // State 2: Bots exist, user not linked
  const botLink = `https://t.me/${primaryBot.botUsername}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>Link your Telegram account to chat with agents.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-lg border p-4 bg-white">
              <QRCodeSVG value={botLink} size={180} />
            </div>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Scan this code with your phone to open Telegram. Send any message — you&apos;ll
              receive a pairing code.
            </p>
            <a
              href={botLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Or open in Telegram
              <ExternalLink className="size-3" />
            </a>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pairing-code">Pairing Code</Label>
            <div className="flex items-center gap-2">
              <Input
                id="pairing-code"
                placeholder="Enter pairing code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleLink();
                  }
                }}
              />
              <Button onClick={handleLink} disabled={linking || !code.trim()}>
                {linking ? "Linking..." : "Link"}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Inline admin setup for connecting Smithers to Telegram ───────────────

function InlineSetup({
  guideOpen,
  onGuideOpenChange,
  botToken,
  onBotTokenChange,
  error,
  saving,
  connectedBotName,
  onConnect,
  onCancel,
}: {
  guideOpen: boolean;
  onGuideOpenChange: (open: boolean) => void;
  botToken: string;
  onBotTokenChange: (value: string) => void;
  error: string;
  saving: boolean;
  connectedBotName: string | null;
  onConnect: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        First, create a Telegram bot for Smithers. Pick a name your team will recognize, e.g.{" "}
        <code className="bg-muted px-1 rounded text-xs">@acme_smithers_bot</code>. The name must be
        unique and can&apos;t be changed later.
      </p>

      <Collapsible open={guideOpen} onOpenChange={onGuideOpenChange}>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
          <ChevronDown className={`size-4 transition-transform ${guideOpen ? "rotate-180" : ""}`} />
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
              <li>Choose a display name (e.g. &quot;Acme Smithers&quot;)</li>
              <li>
                Choose a username ending in <code className="bg-muted px-1 rounded">bot</code> (e.g.{" "}
                <code className="bg-muted px-1 rounded">acme_smithers_bot</code>)
              </li>
              <li>Copy the token BotFather gives you</li>
            </ol>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-2">
        <Label htmlFor="setup-bot-token">Bot Token</Label>
        <Input
          id="setup-bot-token"
          type="password"
          placeholder="Paste your bot token here"
          value={botToken}
          onChange={(e) => onBotTokenChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConnect();
            }
          }}
        />
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="size-3" />
          Your bot token is encrypted at rest and never leaves your server.
        </p>
      </div>

      {connectedBotName && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CircleCheck className="size-4" />
          Connected to @{connectedBotName}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button onClick={onConnect} disabled={!botToken.trim() || saving}>
          {saving ? "Connecting..." : "Connect"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
