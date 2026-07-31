"use client";

import type { ReactNode } from "react";
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
 * The duplicate-write confirmation itself: copy plus dialog, nothing else.
 * Shared by the durable "paused" banner AND the live in-chat error bubble so
 * both retry paths say the same thing.
 *
 * Fully controlled — whether to show it is decided by `GatedRetry`, which asks
 * the server at click time (#1013) rather than trusting a flag computed while
 * the evidence was still in flight. `children` renders the trigger alongside
 * the dialog; it is a plain node rather than an `asChild` trigger so it works
 * with any control regardless of ref/prop forwarding.
 */
export function DuplicateRetryConfirm({
  agentName,
  open,
  onOpenChange,
  onConfirm,
  children,
}: {
  agentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <AlertDialog open={open} onOpenChange={onOpenChange}>
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
                onOpenChange(false);
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
