"use client";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface StartResponse {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

interface MigratedAgent {
  id: string;
  name: string;
  from: string;
  to: string;
}

interface PollResponse {
  status: "pending" | "complete" | "failed";
  accountEmail?: string;
  accountId?: string;
  reason?: string;
  migratedAgents?: MigratedAgent[];
}

export function OpenAiSubscriptionFlow(props: {
  onConnected: (info: { accountEmail: string; migratedAgents: MigratedAgent[] }) => void;
  onCancel?: () => void;
}) {
  const [flow, setFlow] = useState<StartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

  useEffect(() => {
    if (!flow) return;
    let active = true;
    const poll = async () => {
      while (active && !cancelledRef.current) {
        await new Promise((r) => setTimeout(r, (flow.interval ?? 5) * 1000));
        if (!active || cancelledRef.current) return;
        const res = await fetch("/api/providers/openai/subscription/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ flowId: flow.flowId }),
        });
        const body = (await res.json()) as PollResponse;
        if (body.status === "complete" && body.accountEmail) {
          props.onConnected({
            accountEmail: body.accountEmail,
            migratedAgents: body.migratedAgents ?? [],
          });
          return;
        }
        if (body.status === "failed") {
          setError(
            body.reason === "access_denied"
              ? "Authorization was denied."
              : body.reason === "expired_token"
                ? "The code expired. Please try again."
                : "Authorization failed. Please try again."
          );
          setFlow(null);
          return;
        }
      }
    };
    poll();
    return () => {
      active = false;
    };
  }, [flow, props]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/openai/subscription/start", { method: "POST" });
      if (!res.ok) throw new Error("start failed");
      setFlow((await res.json()) as StartResponse);
    } catch {
      setError("Could not start authorization. Please try again.");
    } finally {
      setStarting(false);
    }
  }

  if (!flow) {
    return (
      <div className="space-y-2">
        <Button type="button" onClick={start} disabled={starting}>
          {starting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect with ChatGPT
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm text-muted-foreground">
        Enter this code at openai.com to connect your subscription:
      </p>
      <div className="flex items-center gap-3">
        <code className="text-lg font-semibold tracking-widest">{flow.userCode}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigator.clipboard.writeText(flow.userCode)}
        >
          Copy
        </Button>
      </div>
      <Button asChild variant="default" size="sm">
        <a href={flow.verificationUriComplete} target="_blank" rel="noopener noreferrer">
          Open chatgpt.com/auth/device →
        </a>
      </Button>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Waiting for authorization…
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            cancelledRef.current = true;
            setFlow(null);
            props.onCancel?.();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
