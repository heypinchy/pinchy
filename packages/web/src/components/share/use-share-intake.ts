"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { clearSharedPayload, readSharedPayload } from "@/lib/share-target/share-cache";

interface UseShareIntakeArgs {
  addPendingUpload: (file: File) => void;
  setComposerText?: (text: string) => void;
}

/**
 * Picks up a shared payload cached by the /share picker (`?share=<id>` on
 * the chat URL — see share-picker.tsx) and feeds it into the composer:
 * files go through the same two-phase upload pipeline as a manual
 * attachment pick (`addPendingUpload`), and any shared text/url becomes a
 * text prefill the user can edit before sending — a shared LINK carries no
 * file, so the prefill is its only path into the composer.
 *
 * Runs at most once per share id (guarded solely by a ref) and never throws
 * even if the cache read fails — a corrupted or already-cleared entry is
 * treated like "nothing to attach" rather than crashing the chat. Either
 * way, the `share` param is stripped from the URL afterwards so a refresh
 * doesn't replay the intake. Every OTHER param (notably `?keep`, which is
 * what let this route render `<Chat>` instead of redirecting to the most
 * recent chat — see chat/[agentId]/page.tsx) is preserved.
 *
 * Deliberately NO cleanup-cancellation flag: React StrictMode (Next 16's
 * dev default) runs the mount effect, its cleanup, then the effect again —
 * synchronously, before `readSharedPayload` resolves. A `cancelled` flag set
 * in cleanup would abort the single in-flight read (the re-run bails on the
 * already-committed `handledRef`), leaving the feature a permanent no-op in
 * dev. So we let the one committed run finish. React 18+ does not warn on
 * calling the setters or `router.replace` after an unmount, so the only cost
 * in the genuine unmount-mid-read case is a harmless no-op — far better than
 * never firing at all.
 */
export function useShareIntake({ addPendingUpload, setComposerText }: UseShareIntakeArgs) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const handledRef = useRef(false);

  useEffect(() => {
    const shareId = searchParams.get("share");
    if (!shareId || handledRef.current) return;
    handledRef.current = true;

    (async () => {
      try {
        const payload = await readSharedPayload(shareId);
        if (payload) {
          for (const file of payload.files) {
            addPendingUpload(file);
          }
          const prefill = [payload.text, payload.url].filter(Boolean).join("\n");
          if (prefill) {
            setComposerText?.(prefill);
          }
          await clearSharedPayload(shareId);
        }
      } catch {
        // Corrupted entry, malformed JSON, or Cache API restrictions — treat
        // like "nothing to attach" and still fall through to the URL cleanup
        // below so the chat is never left in a permanently-replaying state.
      }

      const params = new URLSearchParams(searchParams.toString());
      params.delete("share");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    })();
  }, [searchParams, router, pathname, addPendingUpload, setComposerText]);
}
