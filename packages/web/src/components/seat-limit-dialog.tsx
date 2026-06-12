"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SALES_MAILTO, CALENDLY_URL } from "@/lib/conversion-links";

interface SeatLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  maxUsers: number;
  graceCap: number;
}

/**
 * Shown when an invite would exceed the seat grace cap (§ 5). Phase A has a
 * single SKU, so more seats go through the quote path — factual tone, no
 * countdowns, no red. Existing users always keep their access.
 */
export function SeatLimitDialog({ open, onOpenChange, maxUsers, graceCap }: SeatLimitDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Need more than {maxUsers} seats?</DialogTitle>
          <DialogDescription>
            Your license includes {maxUsers} seats with grace up to {graceCap}. Email us for a quote
            you can accept online — no call needed. Existing users keep their access; only new
            invites are paused.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-start gap-2">
          <a href={SALES_MAILTO}>
            <Button>Email sales@heypinchy.com</Button>
          </a>
          <a href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">
            <Button variant="outline">Book a call</Button>
          </a>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
