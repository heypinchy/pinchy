"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface LicenseInfo {
  enterprise: boolean;
  type: string | null;
  org: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  managedByEnv: boolean;
}

interface SettingsLicenseProps {
  onEnterpriseActivated?: () => void;
  initialLicense?: LicenseInfo | null;
}

export function SettingsLicense({ onEnterpriseActivated, initialLicense }: SettingsLicenseProps) {
  const [license, setLicense] = useState<LicenseInfo | null>(initialLicense ?? null);
  const [loading, setLoading] = useState(!initialLicense);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/enterprise/status");
      if (res.ok) {
        const data = await res.json();
        setLicense(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/enterprise/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setLicense(data);
        setKeyInput("");
        setShowInput(false);
        if (data.enterprise) {
          onEnterpriseActivated?.();
        }
      } else {
        const data = await res.json();
        setError(data.error ?? "Failed to save license key");
      }
    } catch {
      setError("Failed to save license key");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>License</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>License</CardTitle>
        <CardDescription>Manage your Pinchy Enterprise license key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {license?.enterprise ? (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={license.type === "trial" ? "secondary" : "default"}>
                {license.type === "trial" ? "Trial" : "Paid"}
              </Badge>
              {license.org && <span className="text-sm text-muted-foreground">{license.org}</span>}
            </div>
            {license.expiresAt && (
              <p className="text-sm">
                Expires:{" "}
                {new Date(license.expiresAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}{" "}
                ({license.daysRemaining} days remaining)
              </p>
            )}
            {license.managedByEnv && (
              <p className="text-sm text-muted-foreground">
                Managed via <code className="bg-muted px-1 rounded">PINCHY_ENTERPRISE_KEY</code>{" "}
                environment variable. Remove it to manage the key here.
              </p>
            )}
            {!showInput && !license.managedByEnv && (
              <Button variant="outline" size="sm" onClick={() => setShowInput(true)}>
                Update Key
              </Button>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              No active license key. Enter a key to enable Enterprise features.
            </p>
            <p className="text-sm">
              <a
                href="https://heypinchy.com/enterprise?utm_source=app&utm_medium=settings"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                Learn more about Enterprise
              </a>
            </p>
          </div>
        )}

        {(showInput || !license?.enterprise) && !license?.managedByEnv && (
          <div className="space-y-2">
            <Label htmlFor="license-key">License Key</Label>
            <Input
              id="license-key"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="eyJ..."
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={saving || !keyInput.trim()}>
                {saving ? "Saving..." : "Save"}
              </Button>
              {showInput && license?.enterprise && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowInput(false);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
