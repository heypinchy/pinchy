"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface TelegramLinkStatus {
  linked: boolean;
  telegramUserId?: string;
}

export function TelegramLinkSettings() {
  const [status, setStatus] = useState<TelegramLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      } else {
        setStatus({ linked: false });
      }
    } catch {
      setStatus({ linked: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

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
        await fetchStatus();
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
        await fetchStatus();
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

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>Link your Telegram account to chat with agents</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>Link your Telegram account to chat with agents</CardDescription>
      </CardHeader>
      <CardContent>
        {status?.linked ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge className="bg-green-600 text-white">Linked</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Telegram User ID: {status.telegramUserId}
            </div>
            <Button variant="outline" onClick={handleUnlink} disabled={unlinking}>
              {unlinking ? "Unlinking..." : "Unlink"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              To link your Telegram account, send any message to the agent&apos;s bot on Telegram.
              You&apos;ll receive a pairing code.
            </p>
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
        )}
      </CardContent>
    </Card>
  );
}
