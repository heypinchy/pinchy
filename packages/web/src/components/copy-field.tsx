"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyFieldProps {
  /** The link or secret to hand out. Shown in full, so it can be checked. */
  value: string;
  /** What the value is ("Invite link", "API key"). Names the group and the announcement. */
  label: string;
  /**
   * Id of a visible label for the value. The group then takes its name from
   * it instead of from `label`, so screen readers don't read the name twice.
   */
  labelledBy?: string;
  /**
   * Focus the Copy button when the field appears. For a value that replaces
   * the control that produced it (Create Invite, Reset Password): the person
   * lands on the next thing to do, and a screen reader hears that it's there.
   */
  autoFocus?: boolean;
  /** Label of the copy button. Defaults to "Copy". */
  copyLabel?: string;
  /**
   * Offer the Web Share API as a secondary action. Only for links meant to be
   * passed to a person — never for API keys or other secrets an admin keeps —
   * and only shown where the browser has `navigator.share` (phones, tablets,
   * some desktop browsers).
   */
  share?: { title: string };
  /** Render the value in a monospace font (keys, tokens). */
  monospace?: boolean;
  /**
   * Style of the Copy button. Primary by default; "outline" where the copy is
   * one step of a form that has its own primary button (OAuth setup).
   */
  copyVariant?: "default" | "outline";
  className?: string;
}

const noopSubscribe = () => () => {};
const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
// Rendered on the server as "no share", so hydration never disagrees.
const noWebShareOnServer = () => false;

/**
 * A value Pinchy hands to an admin to pass on: an invite or reset link, a
 * one-time API key, a redirect URI. Copying is the main thing people do with
 * it, so Copy is the primary button. It confirms in place ("Copied", for about
 * two seconds) and through a polite live region, so screen readers hear it
 * without losing focus. Where the browser won't copy (plain-HTTP intranet
 * installs, denied permission), the value is selected and the person is told
 * to press Ctrl+C / ⌘C instead.
 */
export function CopyField(props: CopyFieldProps) {
  // Resend and Reset Password hand a new link to the same mounted field; a
  // fresh instance per value keeps the last link's "Copied" or "press Ctrl+C"
  // from standing under the new one.
  return <CopyFieldForValue key={props.value} {...props} />;
}

function CopyFieldForValue({
  value,
  label,
  labelledBy,
  autoFocus = false,
  copyLabel = "Copy",
  share,
  monospace = false,
  copyVariant = "default",
  className,
}: CopyFieldProps) {
  const { isCopied, copy } = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);
  const valueRef = useRef<HTMLElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const canShare = useSyncExternalStore(noopSubscribe, hasWebShare, noWebShareOnServer);
  // The hook's isCopied lasts ~2 s; a failed attempt inside that window must
  // win over the earlier success.
  const showCopied = isCopied && !copyFailed;

  async function handleCopy() {
    const ok = await copy(value, { anchor: groupRef.current });
    setCopyFailed(!ok);
    if (!ok) selectValue();
  }

  function selectValue() {
    const node = valueRef.current;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function handleShare() {
    if (!share || !hasWebShare()) return;
    try {
      await navigator.share({ title: share.title, url: value });
    } catch {
      // Cancelling the share sheet rejects with AbortError. Nothing to report:
      // the value and the Copy button are still right there.
    }
  }

  let announcement = "";
  if (showCopied) announcement = `${label} copied.`;
  else if (copyFailed)
    announcement = "Couldn't copy automatically. It's selected — press Ctrl+C (⌘C on a Mac).";

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      // Stacks by its own width, not the viewport's: in a narrow sheet on a
      // wide screen the buttons go below the value instead of squeezing it.
      className={cn("@container space-y-2", className)}
    >
      <div className="flex flex-col gap-2 @md:flex-row @md:items-start">
        <code
          ref={valueRef}
          className={cn(
            "min-w-0 flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 text-sm",
            !monospace && "font-sans"
          )}
        >
          {value}
        </code>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant={copyVariant} onClick={handleCopy} autoFocus={autoFocus}>
            {showCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {showCopied ? "Copied" : copyLabel}
          </Button>
          {share && canShare && (
            <Button type="button" variant="outline" onClick={handleShare}>
              <Share2 aria-hidden="true" />
              Share
            </Button>
          )}
        </div>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={copyFailed ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {announcement}
      </p>
    </div>
  );
}
