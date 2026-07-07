/**
 * Persistent AI disclosure next to the agent name (EU AI Act Article 50 — users
 * must be informed when they interact with an AI system). #115
 *
 * Rendered as quiet, muted label text rather than a badge: every Pinchy agent
 * is an AI assistant, so the disclosure belongs to the agent's identity, not to
 * a UI control that competes with the functional Private/Shared badge. It is a
 * plain, always-visible text node — not icon-only or tooltip-only — so it stays
 * clear, accessible, and legible on every platform, including touch where hover
 * tooltips never appear.
 *
 * The disclosure is non-configurable in v1: every Pinchy agent is an AI
 * assistant, so the label is always honest. A future admin-configurable custom
 * disclosure text can replace the body without changing the call site.
 */
export function AiDisclosureLabel() {
  return (
    <span
      className="text-xs font-normal text-muted-foreground shrink-0 whitespace-nowrap"
      data-testid="ai-disclosure-label"
    >
      AI assistant
    </span>
  );
}
