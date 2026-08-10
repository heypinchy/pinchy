"use client";

import { Check, Ban, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AccessState = "off" | "ask" | "allow";

const STATES: Array<{ value: AccessState; icon: typeof Check; title: string }> = [
  { value: "off", icon: Ban, title: "Not allowed" },
  { value: "ask", icon: HelpCircle, title: "Ask first — the agent pauses for a confirmation" },
  { value: "allow", icon: Check, title: "Allowed — the agent acts on its own" },
];

interface AccessCellProps {
  value: AccessState;
  onChange: (next: AccessState) => void;
  /** What this cell governs, e.g. "delete account.move". Read by screen readers. */
  label: string;
  disabled?: boolean;
}

/**
 * One cell of a permission matrix: not allowed · ask first · allowed.
 *
 * Deliberately NOT a tri-state checkbox. `aria-checked="mixed"` is standardised
 * with a different meaning — "partially checked", a group whose children differ
 * — and it reads as system-set, because users cannot click into it. Reusing
 * that dash for "needs approval" would break a convention rather than adopt
 * one, and would do it on a security setting.
 *
 * It is a radiogroup instead, which is what this actually is: exactly one of
 * three. That also gives arrow-key navigation for free, where three separate
 * buttons would give none.
 */
export function AccessCell({ value, onChange, label, disabled }: AccessCellProps) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex rounded-md border", disabled && "opacity-50")}
    >
      {STATES.map(({ value: state, icon: Icon, title }) => {
        const selected = value === state;
        return (
          <button
            key={state}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={title}
            title={title}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(state)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const i = STATES.findIndex((s) => s.value === value);
              const next = e.key === "ArrowRight" ? i + 1 : i - 1;
              const wrapped = (next + STATES.length) % STATES.length;
              onChange(STATES[wrapped].value);
            }}
            className={cn(
              "flex h-7 w-7 items-center justify-center first:rounded-l-[5px] last:rounded-r-[5px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? state === "ask"
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : state === "allow"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                : "text-muted-foreground/40 hover:text-muted-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
