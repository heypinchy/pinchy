"use client";

/**
 * General Settings → Support.
 *
 * The diagnostics export is inherently per-agent, so it now lives in each
 * agent's Settings → Diagnostics tab (agent already in context — no picker).
 * This section is just a pointer so people who look here still find their way.
 */
export function SettingsSupport() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Support</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Run into an issue with an agent? Open that agent&apos;s{" "}
        <span className="font-medium">Settings &rarr; Diagnostics</span> tab to generate a
        diagnostics export you can share with Pinchy support. You can also report a specific message
        right from chat using the &ldquo;Report issue to support&rdquo; action.
      </p>
    </div>
  );
}
