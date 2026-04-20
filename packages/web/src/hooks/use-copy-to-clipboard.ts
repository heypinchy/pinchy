import { useState } from "react";

export function useCopyToClipboard({ copiedDuration = 2000 }: { copiedDuration?: number } = {}) {
  const [isCopied, setIsCopied] = useState(false);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), copiedDuration);
  }

  return { isCopied, copy };
}
