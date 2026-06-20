"use client";

import { useState, type ReactNode } from "react";
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

/**
 * Gate a retry behind a duplicate-write confirmation when the failed run had
 * already executed a tool. `children` receives an `open` callback to wire to the
 * trigger (a RetryButton, a plain Button, …) — a controlled dialog rather than
 * an `asChild` trigger so it works with any control regardless of ref/prop
 * forwarding. Shared by the durable "paused" banner AND the live in-chat error
 * bubble so the duplicate-write copy is identical on both retry paths.
 */
export function DuplicateRetryConfirm({
  agentName,
  onConfirm,
  children,
}: {
  agentName?: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry may duplicate actions</AlertDialogTitle>
            <AlertDialogDescription>
              {agentName ?? "The agent"} had already started performing actions before it stopped.
              Retrying re-runs the whole request and may create duplicates (e.g. duplicate records).
              Continue only if you&apos;ve checked what was already done.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Retry anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
