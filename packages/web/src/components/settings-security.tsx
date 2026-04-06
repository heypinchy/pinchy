"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface DomainStatus {
  domain: string | null;
  currentHost: string | null;
  isHttps: boolean;
}

export function SettingsSecurity() {
  const router = useRouter();
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showRestarting, setShowRestarting] = useState(false);
  const [error, setError] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/domain");
      if (res.ok) {
        setStatus(await res.json());
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const waitForRestart = async () => {
    // Wait for the server to actually go down
    await new Promise((r) => setTimeout(r, 2000));

    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // Server still down, retry
      }
      setTimeout(poll, 2000);
    };
    poll();
  };

  const handleLock = async () => {
    setLocking(true);
    try {
      const res = await fetch("/api/settings/domain", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setStatus((prev) => (prev ? { ...prev, domain: data.domain } : prev));
        toast.success(`Domain locked to ${data.domain}.`);
        if (data.restart) {
          setShowRestarting(true);
          waitForRestart();
        }
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to lock domain");
      }
    } catch {
      toast.error("Failed to lock domain");
    } finally {
      setLocking(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/settings/domain", { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        setStatus((prev) => (prev ? { ...prev, domain: null } : prev));
        setShowRemoveConfirm(false);
        toast.success("Domain lock removed");
        if (data.restart) {
          setShowRestarting(true);
          waitForRestart();
        } else {
          router.refresh();
        }
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to remove domain lock");
      }
    } catch {
      toast.error("Failed to remove domain lock");
    } finally {
      setRemoving(false);
    }
  };

  if (loading) return null;
  if (error || !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-500" />
            Domain & HTTPS
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load security settings.</p>
        </CardContent>
      </Card>
    );
  }

  // State C: Domain is locked
  if (status.domain) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-green-600" />
              Domain & HTTPS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Locked to <strong>{status.domain}</strong>. Your instance is secured.
            </p>
            {!showRemoveConfirm ? (
              <Button variant="outline" size="sm" onClick={() => setShowRemoveConfirm(true)}>
                Remove domain lock
              </Button>
            ) : (
              <div className="space-y-3 rounded-md border p-4">
                <p className="text-sm">
                  Removing the domain lock will make Pinchy accessible from any address again. Login
                  sessions will no longer be protected against interception.
                </p>
                <p className="text-sm text-muted-foreground">
                  To change your domain, remove the current lock, then access Pinchy via your new
                  domain and lock it again.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleRemove}
                    disabled={removing}
                  >
                    {removing ? "Removing\u2026" : "Remove lock & restart"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowRemoveConfirm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        {showRestarting && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="mt-4 text-lg font-medium">Applying security settings...</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pinchy is restarting. This takes a few seconds.
            </p>
          </div>
        )}
      </>
    );
  }

  // State B: Not locked, but on HTTPS + domain
  if (status.isHttps && status.currentHost) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-amber-500" />
              Domain & HTTPS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              You&apos;re accessing Pinchy via <strong>{status.currentHost}</strong> over HTTPS.
            </p>
            <p className="text-sm text-muted-foreground">Locking this domain will:</p>
            <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
              <li>Only allow access through this domain</li>
              <li>Protect login sessions from being intercepted</li>
              <li>Block access from other addresses (e.g. direct IP)</li>
            </ul>
            <Button onClick={handleLock} disabled={locking}>
              {locking ? "Locking\u2026" : `Lock ${status.currentHost} & restart`}
            </Button>
          </CardContent>
        </Card>
        {showRestarting && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="mt-4 text-lg font-medium">Applying security settings...</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pinchy is restarting. This takes a few seconds.
            </p>
          </div>
        )}
      </>
    );
  }

  // State A: Not locked, not on HTTPS
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-5 text-amber-500" />
          Domain & HTTPS
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">Your instance is not secured with HTTPS. To lock your domain:</p>
        <ol className="list-decimal pl-5 text-sm text-muted-foreground space-y-1">
          <li>Set up a reverse proxy with HTTPS (e.g. Caddy)</li>
          <li>Point your domain to this server</li>
          <li>Open Pinchy via your domain over HTTPS</li>
          <li>Come back to this page to confirm</li>
        </ol>
        <div className="flex items-center gap-3">
          <Button disabled aria-label="Lock this domain">
            Lock this domain
          </Button>
          <a
            href="https://docs.heypinchy.com/guides/vps-deployment/#set-up-https-with-caddy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline"
          >
            Read the setup guide →
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
