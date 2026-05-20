"use client";

/**
 * Static informational content shown inside a nested dialog when the user
 * clicks the "What's included" link on the {@link DiagnosticsExportDialog}.
 *
 * The wording is intentionally plain and reassuring — users should understand
 * what they're about to share with Pinchy support before they generate the
 * bundle. Mirrors the actual contents produced by
 * `packages/web/src/lib/diagnostics/bundle-builder.ts`.
 */
export function DiagnosticsWhatsIncluded() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        We package a small snapshot of context so support can reproduce what you saw. Nothing leaves
        your browser until you choose to share the file.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Your recent conversation turns (up to the message you reported on).</li>
        <li>Model name, provider, and version used for the agent.</li>
        <li>Tool calls with their arguments and sanitized results.</li>
        <li>Token usage and finish reasons for each turn.</li>
        <li>Pinchy, OpenClaw, and openclaw-node version info.</li>
      </ul>
      <p className="text-muted-foreground">
        Secrets and email addresses are automatically removed, and the session key is hashed. You
        decide if and how to share the file with Pinchy support.
      </p>
    </div>
  );
}
