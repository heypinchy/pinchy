/**
 * Refuse a tool call that carries a parameter the tool does not declare.
 *
 * A tool reads its arguments by exact name: `params.to`, `params.url`.
 * Anything else rides along unread — and is still shown to the person
 * approving the call. A prompt-injected agent can exploit that gap: send
 * `{"to": "attacker@evil.com", "to ": "boss@firma.at"}` and the card offers
 * two recipients, one of which is never used; put six URLs under `target`,
 * `destination` and `targets` ahead of the one `url` a fetch reads, and they
 * take the room a prompt has for naming the hosts a call reaches. Any tool
 * can be gated, so every tool refuses — the cleanest call is one that carries
 * nothing the tool does not read.
 *
 * The schemas declare `additionalProperties: false`, and OpenClaw's argument
 * validation enforces that before a tool runs — but not for every provider:
 * its schema cleaning for Gemini-profile models strips `additionalProperties`
 * from the very schema it validates against. So the tool checks again at its
 * own edge, against the same schema object.
 *
 * Every plugin that registers tools carries this file byte for byte, and
 * registers through `refusingUnknownParams(api)`; `unknown-params-drift.test.ts`
 * in packages/web holds both.
 */
export function unknownParams(
  params: Record<string, unknown>,
  schema: { properties?: Record<string, unknown> }
): string[] {
  const declared = schema.properties ?? {};
  return Object.keys(params).filter((key) => !Object.hasOwn(declared, key));
}

/** What the model reads: the offending keys, escaped, and the ones it may use. */
export function unknownParamsMessage(
  tool: string,
  unknown: string[],
  schema: { properties?: Record<string, unknown> }
): string {
  const named = unknown
    .slice(0, 5)
    .map((key) => JSON.stringify(key.length > 60 ? `${key.slice(0, 60)}…` : key))
    .join(", ");
  const more = unknown.length > 5 ? ` and ${unknown.length - 5} more` : "";
  const declared = Object.keys(schema.properties ?? {});
  return (
    `${tool} does not take the parameter${unknown.length === 1 ? "" : "s"} ${named}${more}. ` +
    (declared.length > 0
      ? `It takes only: ${declared.join(", ")}. Re-issue the call with only those parameters.`
      : `It takes no parameters. Re-issue the call without any.`)
  );
}

interface Tool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: Record<string, unknown>, ...rest: never[]) => unknown;
}

/** Marks a factory the wrapper produced, so the drift guard can tell. */
const REFUSES = Symbol.for("pinchy.refusesUnknownParams");

function refusing(tool: Tool): Tool {
  const parameters = { ...tool.parameters, additionalProperties: false };
  return {
    ...tool,
    parameters,
    execute(toolCallId, params, ...rest) {
      const unknown = unknownParams(params ?? {}, parameters);
      if (unknown.length === 0) return tool.execute(toolCallId, params, ...rest);
      // `details` carries only how many — a key is free text the model chose,
      // and may well be an address. Setting it also keeps the audit route
      // from logging the raw params.
      return Promise.resolve({
        isError: true,
        content: [{ type: "text", text: unknownParamsMessage(tool.name, unknown, parameters) }],
        details: { error: "Refused: unknown parameters", unknownParams: unknown.length },
      });
    },
  };
}

/**
 * The plugin API, with every tool registered through it refusing undeclared
 * parameters. Everything else reads through to the API as it is — including
 * `pluginConfig`, which some plugins read again at call time.
 */
export function refusingUnknownParams<Api extends { registerTool: (...args: never[]) => void }>(
  api: Api
): Api {
  const register = api.registerTool as unknown as (
    factory: (ctx: unknown) => Tool | null,
    ...rest: unknown[]
  ) => void;
  const registerTool = (factory: (ctx: unknown) => Tool | null, ...rest: unknown[]) => {
    const wrapped = (ctx: unknown) => {
      const tool = factory(ctx);
      return tool ? refusing(tool) : tool;
    };
    Object.defineProperty(wrapped, REFUSES, { value: true });
    register.call(api, wrapped, ...rest);
  };
  return new Proxy(api, {
    get: (target, key) => (key === "registerTool" ? registerTool : Reflect.get(target, key)),
  });
}

/** Was this factory registered through `refusingUnknownParams`? */
export function refusesUnknownParams(factory: unknown): boolean {
  return typeof factory === "function" && (factory as { [REFUSES]?: boolean })[REFUSES] === true;
}
