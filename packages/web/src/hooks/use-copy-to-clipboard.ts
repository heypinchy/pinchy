import { useEffect, useRef, useState } from "react";

/**
 * Copy text to the clipboard, robust to non-secure contexts.
 *
 * `navigator.clipboard` is undefined when the page is served over plain HTTP on
 * a non-localhost host — the norm for self-hosted Pinchy on an internal IP. The
 * async Clipboard API can also reject (permissions, focus). In both cases we
 * fall back to the legacy `document.execCommand("copy")`. `copy` never throws;
 * it returns whether the copy succeeded so callers can surface a toast on
 * failure instead of dropping an unhandled rejection.
 */
export function useCopyToClipboard({ copiedDuration = 2000 }: { copiedDuration?: number } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  /**
   * `anchor`: an element inside the component doing the copy. The fallback's
   * hidden textarea goes inside it, so it stays within any focus trap the
   * component sits in (a Radix dialog or sheet). Without one, the textarea
   * goes next to the focused element — which is not the clicked button in
   * Safari and Firefox on macOS, since they don't focus buttons on click.
   */
  async function copy(
    text: string,
    { anchor }: { anchor?: HTMLElement | null } = {}
  ): Promise<boolean> {
    const ok = await writeToClipboard(text, anchor ?? null);
    // The write is async, so the component may be gone by now — in which case the
    // cleanup has already run and would not catch a timer scheduled after it.
    if (ok && mounted.current) {
      setIsCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setIsCopied(false), copiedDuration);
    }
    return ok;
  }

  return { isCopied, copy };
}

async function writeToClipboard(text: string, anchor: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Secure-context API present but refused (permissions, no focus); fall back.
  }
  return copyViaExecCommand(text, anchor);
}

function copyViaExecCommand(text: string, anchor: HTMLElement | null): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  // Not onto <body>: inside a modal dialog a focus trap pulls focus straight
  // back from anything outside it, and execCommand then copies nothing while
  // still reporting success. Inside the caller's anchor if it gave one, else
  // next to whatever has focus.
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host =
    anchor ??
    (previouslyFocused && previouslyFocused !== document.body
      ? (previouslyFocused.parentElement ?? document.body)
      : document.body);
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.tabIndex = -1;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    host.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus({ preventScroll: true });
  }
}
