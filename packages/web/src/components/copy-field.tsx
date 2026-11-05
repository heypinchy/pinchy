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
  /** Label of the copy button. Defaults to "Copy". */
  copyLabel?: string;
  /**
   * Offer the Web Share API as a secondary action. Only for links meant to be
   * passed to a person — never for secrets — and only shown where the browser
   * has `navigator.share` (phones, tablets, some desktop browsers).
   */
  share?: { title: string };
  /** Render the value in a monospace font (keys, tokens). */
  monospace?: boolean;
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
export function CopyField({
  value,
  label,
  copyLabel = "Copy",
  share,
  monospace = false,
  className,
}: CopyFieldProps) {
  const { isCopied, copy } = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);
  const valueRef = useRef<HTMLElement>(null);
  const canShare = useSyncExternalStore(noopSubscribe, hasWebShare, noWebShareOnServer);

  async function handleCopy() {
    const ok = await copy(value);
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
  if (isCopied) announcement = `${label} copied.`;
  else if (copyFailed)
    announcement = "Couldn't copy automatically. It's selected — press Ctrl+C (⌘C on a Mac).";

  return (
    <div role="group" aria-label={label} className={cn("space-y-2", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
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
          <Button type="button" onClick={handleCopy}>
            {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {isCopied ? "Copied" : copyLabel}
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
        className={copyFailed && !isCopied ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {announcement}
      </p>
    </div>
  );
}
