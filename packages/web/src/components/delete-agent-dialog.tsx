"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
import { useRestart } from "@/components/restart-provider";
import { apiDelete, errorMessage } from "@/lib/api-client";

interface DeleteAgentDialogProps {
  agentId: string;
  agentName: string;
}

export function DeleteAgentDialog({ agentId, agentName }: DeleteAgentDialogProps) {
  const router = useRouter();
  const [error, setError] = useState("");
  const { triggerRestart } = useRestart();

  async function handleDelete() {
    try {
      await apiDelete(`/api/agents/${agentId}`);
      triggerRestart();
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e, "Failed to delete agent"));
    }
  }

  return (
    <div className="space-y-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">Delete Agent</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agentName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the agent and its configuration. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
