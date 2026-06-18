import { useState } from "react";

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

  async function copy(text: string): Promise<boolean> {
    const ok = await writeToClipboard(text);
    if (ok) {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    }
    return ok;
  }

  return { isCopied, copy };
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Secure-context API present but refused (permissions, no focus); fall back.
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
