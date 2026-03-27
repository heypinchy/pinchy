"use client";

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ExternalLink, CircleCheck } from "lucide-react";
import { AgentTelegramSettings } from "./agent-telegram-settings";

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
  const [linkError, setLinkError] = useState("");
  const [pairingStep, setPairingStep] = useState<1 | 2>(1);

  const [removingAll, setRemovingAll] = useState(false);

  // Admin setup state
  const [showSetup, setShowSetup] = useState(false);
  const [smithersId, setSmithersId] = useState<string | null>(null);

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

  // Find Smithers agent for inline setup
  useEffect(() => {
    if (isAdmin) {
      fetch("/api/agents")
        .then((res) => {
          if (!res.ok) return [];
          return res.json();
        })
        .then((data) => {
          const agents = Array.isArray(data) ? data : [];
          const smithers = agents.find(
            (a: { avatarSeed: string | null }) => a.avatarSeed === "__smithers__"
          );
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
    setLinkError("");
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });

      if (res.ok) {
        setCode("");
        setLinkError("");
        toast.success("Telegram account linked");
        await fetchData();
      } else {
        const data = await res.json();
        setLinkError(data.error || "Failed to link Telegram account");
      }
    } catch {
      setLinkError("Failed to link Telegram account");
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
        setPairingStep(1);
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

  async function handleRemoveAll() {
    setRemovingAll(true);
    try {
      const res = await fetch("/api/settings/telegram/all", { method: "DELETE" });
      if (res.ok) {
        toast.success("Telegram removed");
        await fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to remove Telegram");
      }
    } catch {
      toast.error("Failed to remove Telegram");
    } finally {
      setRemovingAll(false);
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

  const primaryBot = bots[0];

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
              {primaryBot && (
                <span className="text-sm text-muted-foreground">via @{primaryBot.botUsername}</span>
              )}
            </div>
            <Button variant="outline" onClick={handleUnlink} disabled={unlinking}>
              {unlinking ? "Unlinking..." : "Unlink Telegram account"}
            </Button>
            {isAdmin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={removingAll}
                  >
                    {removingAll ? "Removing..." : "Remove Telegram for everyone"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove Telegram for everyone?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will disconnect all Telegram bots and unlink all users. Everyone will
                      lose Telegram access. You can set it up again later.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={handleRemoveAll}>
                      Remove Telegram
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasBots = bots.length > 0;

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
              ) : smithersId ? (
                <AgentTelegramSettings
                  agentId={smithersId}
                  onConnected={fetchData}
                  bare
                  isSmithers
                />
              ) : (
                <p className="text-sm text-muted-foreground">Loading...</p>
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
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          <div
            className={`h-1.5 flex-1 rounded-full ${pairingStep >= 1 ? "bg-primary" : "bg-muted"}`}
          />
          <div
            className={`h-1.5 flex-1 rounded-full ${pairingStep >= 2 ? "bg-primary" : "bg-muted"}`}
          />
        </div>

        {pairingStep === 1 ? (
          <div className="space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="rounded-lg border p-4 bg-white">
                <QRCodeSVG value={botLink} size={180} />
              </div>
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Scan this code with your phone to open the bot in Telegram. Send any message to get
                started.
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
            <Button className="w-full" onClick={() => setPairingStep(2)}>
              I sent a message
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              The bot replied with a message like this. Copy the{" "}
              <span className="font-semibold text-foreground">pairing code</span> and paste it
              below.
            </p>

            {/* Mock Telegram incoming message bubble */}
            <div className="flex select-none pointer-events-none">
              <div className="max-w-xs rounded-2xl rounded-bl-sm bg-white border shadow px-3.5 py-2.5 text-sm text-gray-400 space-y-2">
                <p>OpenClaw: access not configured.</p>
                <p>Your Telegram user id: 1234567890</p>
                <div className="rounded-md border-2 border-primary/30 bg-primary/5 px-2.5 py-1.5 text-gray-800">
                  Pairing code: <span className="font-bold text-primary">ABC123XY</span>
                </div>
                <p>
                  Ask the bot owner to approve with:
                  <br />
                  openclaw pairing approve telegram ABC123XY
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pairing-code">Pairing Code</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="pairing-code"
                  placeholder="e.g. ABC123XY"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setLinkError("");
                  }}
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
              {linkError && <p className="text-sm text-destructive">{linkError}</p>}
            </div>

            <button
              onClick={() => setPairingStep(1)}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              &larr; Back
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
