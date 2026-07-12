"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import { type Agent, sortAgents } from "@/components/agent-list";
import { getAgentAvatarSvg } from "@/lib/avatar";
import {
  readSharedPayload,
  sweepStaleShares,
  type SharedPayload,
} from "@/lib/share-target/share-cache";

interface SharePickerProps {
  agents: Agent[];
}

/** Loading sentinel distinct from "checked and found nothing" (`null`). */
const LOADING = Symbol("loading");

function FilePreviewThumb({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = file.type.startsWith("image/");

  useEffect(() => {
    if (!isImage || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    // setTimeout(0) is required: calling setState synchronously inside an
    // effect body triggers the react-hooks/set-state-in-effect ESLint rule
    // (see use-chat-status.ts for the same pattern). The negligible delay
    // is imperceptible; cleanup revokes the URL and cancels the timer.
    const t = setTimeout(() => setSrc(objectUrl), 0);
    return () => {
      clearTimeout(t);
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, isImage]);

  if (isImage && src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={file.name}
        className="size-16 shrink-0 rounded-lg border object-cover"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="flex size-16 shrink-0 items-center justify-center rounded-lg border bg-muted">
      <FileText className="size-6 text-muted-foreground" />
    </div>
  );
}

function SharePreview({ payload }: { payload: SharedPayload }) {
  const { files, title, text, url } = payload;

  if (files.length > 0) {
    return (
      <div className="flex flex-wrap gap-3">
        {files.map((file, index) => (
          <div key={`${file.name}-${index}`} className="flex items-center gap-3">
            <FilePreviewThumb file={file} />
            <span className="max-w-48 truncate text-sm text-muted-foreground" title={file.name}>
              {file.name}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const excerpt = [title, text, url].filter(Boolean).join(" — ");
  if (!excerpt) return null;

  return <p className="line-clamp-3 text-sm text-muted-foreground">{excerpt}</p>;
}

function EmptyState({ reason }: { reason?: "retry" }) {
  // `retry` means the SW-miss server fallback (share-target/route.ts) sent us
  // here because a stale service worker let the POST hit the network — the
  // share was interrupted rather than expired, so say so honestly.
  const { heading, body } =
    reason === "retry"
      ? {
          heading: "Sharing didn't go through",
          body: "Something interrupted the share before it reached Pinchy. Please try sharing again.",
        }
      : {
          heading: "Nothing to share",
          body: "We couldn't find what you shared — it may have expired, or the share didn't come through. Try sharing again.",
        };

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-lg font-semibold">{heading}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      <Link
        href="/agents"
        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Back to your agents
      </Link>
    </div>
  );
}

export function SharePicker({ agents }: SharePickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shareId = searchParams.get("share_id");
  const shareError = searchParams.get("error");
  const [payload, setPayload] = useState<SharedPayload | null | typeof LOADING>(
    shareId ? LOADING : null
  );

  useEffect(() => {
    // Reclaim shares the user previewed here but never sent — Cache Storage
    // has no TTL of its own, so orphaned entries (potentially 15 MB photos)
    // would otherwise linger until quota pressure. One hour comfortably
    // outlasts any real share → pick flow.
    sweepStaleShares(60 * 60 * 1000).catch(() => {});
  }, []);

  useEffect(() => {
    // No id at all (unknown/expired share, or the `?error=retry` fallback) —
    // the initial `useState` above already reflects this as `null`, so there
    // is nothing to fetch or to set here.
    if (!shareId) return;
    let cancelled = false;
    readSharedPayload(shareId).then(
      (result) => {
        if (!cancelled) setPayload(result);
      },
      // A cache read can throw (corrupted entry, malformed JSON, private-
      // browsing Cache API restrictions, quota/security errors). Treat any
      // failure the same as "nothing to share" so the user always gets the
      // friendly empty state with a way back, never a permanently blank page.
      () => {
        if (!cancelled) setPayload(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  if (payload === LOADING) {
    return null;
  }

  if (!payload) {
    return <EmptyState reason={shareError === "retry" ? "retry" : undefined} />;
  }

  const sortedAgents = sortAgents(agents);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 p-4 md:p-8">
      <SharePreview payload={payload} />
      <div>
        <h1 className="mb-3 text-lg font-semibold">Which agent?</h1>
        <ul className="flex flex-col gap-1">
          {sortedAgents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => router.push(`/chat/${agent.id}?keep&share=${shareId}`)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name })}
                  alt=""
                  className="size-9 shrink-0 rounded-full"
                />
                <span className="truncate font-semibold">{agent.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
