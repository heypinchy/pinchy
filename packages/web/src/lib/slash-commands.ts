/**
 * In-composer slash commands (#611).
 *
 * The chat composer intercepts a leading `/<command>` before dispatching the
 * message to the model: known commands run a handler against capabilities
 * Pinchy already has (compact / start a new chat / list commands); unknown
 * leading-slash text falls through and is sent as a normal message.
 *
 * `parseSlashCommand` is pure and unit-tested; the runtime hook wires it into
 * the send path (see `use-ws-runtime.ts`) and the Chat layer supplies the
 * handlers.
 */

export type SlashCommandName = "compact" | "new" | "reset" | "help";

export interface SlashCommand {
  name: SlashCommandName;
  /** The text after the command token, trimmed. Most commands ignore it. */
  arg?: string;
}

/**
 * Metadata for the `/help` listing and any future autocomplete UI. Keep the
 * descriptions short — they are shown verbatim in the help toast.
 */
export const SLASH_COMMANDS: ReadonlyArray<{
  name: SlashCommandName;
  description: string;
}> = [
  { name: "compact", description: "Compact the conversation (free up context, keep history)." },
  { name: "new", description: "Start a new conversation with this agent." },
  { name: "reset", description: "Alias for /new — start a fresh conversation." },
  { name: "help", description: "Show the available slash commands." },
];

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));

/**
 * Parse a composer message for a leading slash command.
 *
 * Rules:
 *  - The trimmed text must start with `/`.
 *  - The first whitespace-delimited token (without the leading `/`) must be a
 *    known command name, matched case-insensitively.
 *  - Any text after the command token is returned as `arg` (trimmed). Most
 *    commands ignore it today.
 *  - Returns `null` for unknown commands or text that doesn't start with `/`,
 *    so the message is sent to the model as normal.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Split on the first run of whitespace so the command token is clean and the
  // rest (which may itself contain spaces) is the arg.
  const firstSpace = trimmed.search(/\s/);
  const commandToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const arg = firstSpace === -1 ? undefined : trimmed.slice(firstSpace).trim();

  // commandToken starts with `/`; strip it and lowercase.
  const name = commandToken.slice(1).toLowerCase();
  if (!KNOWN_COMMANDS.has(name)) return null;

  return { name: name as SlashCommandName, arg: arg || undefined };
}
