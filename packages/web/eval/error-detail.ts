/**
 * Says what a failed eval run actually failed at.
 *
 * `String(err)` on a node fetch rejection is the six words `TypeError: fetch
 * failed`, and node puts the real fault — the code, the address, the TLS
 * error — in `err.cause`, which `String()` throws away. The first real
 * Layer-3 KB sweep recorded 15 of 48 runs with exactly those six words, and
 * afterwards nothing in the record could say whether the local stack or the
 * Ollama Cloud uplink had gone: both are called from inside one try-block, and
 * they mean opposite things.
 *
 * `isTransportError` is the other half. A network fault is worth retrying and
 * must never be booked as a model result; an assertion failure or a run
 * timeout is the measurement and must never be retried away. The dividing line
 * is deliberately narrow — plumbing only.
 */

/** Fields node attaches to a system-level failure. */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
}

/** OS/undici codes that mean "the connection did not happen", never "the answer was wrong". */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Message fragments that identify a transport fault carrying no `code`.
 * Kept to shapes that cannot also describe a product failure: "timeout" alone
 * is excluded on purpose, because a Playwright wait and an unstoppable model
 * both produce one and neither is the network.
 */
const TRANSPORT_MESSAGES = ["fetch failed", "socket hang up", "network error", "other side closed"];

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/**
 * The error and everything it blames, breadth-first, each node visited once.
 * A `cause` that points back at its own error is not hypothetical enough to
 * ignore — the harness that exists to report a failure must not hang on one.
 */
function errorChain(err: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!isErrorLike(current) || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);

    if (current.cause !== undefined) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }

  return chain;
}

function describeOne(err: ErrorLike): string {
  const name = typeof err.name === "string" ? err.name : "Error";
  const message = typeof err.message === "string" ? err.message : "";
  const code = typeof err.code === "string" && !message.includes(err.code) ? ` [${err.code}]` : "";
  return `${name}: ${message}${code}`;
}

/**
 * A one-line description that names the endpoint and the OS-level code, not
 * just the fact that something threw.
 */
export function describeError(err: unknown): string {
  const chain = errorChain(err);
  if (chain.length === 0) return String(err);

  const [head, ...causes] = chain;
  if (causes.length === 0) return describeOne(head);
  return `${describeOne(head)} (cause: ${causes.map(describeOne).join(" ← ")})`;
}

/**
 * Whether this failure is the network rather than the measurement.
 *
 * True means "retry it, and if it keeps failing, record an invalid trial".
 * False means "this IS the result" — so the check errs towards false: a defect
 * mis-read as a network blip is retried four times and then filed under a note
 * blaming the uplink, which is how a real bug disappears from a scorecard.
 */
export function isTransportError(err: unknown): boolean {
  return errorChain(err).some((link) => {
    if (typeof link.code === "string" && TRANSPORT_CODES.has(link.code)) return true;
    const message = typeof link.message === "string" ? link.message.toLowerCase() : "";
    return TRANSPORT_MESSAGES.some((fragment) => message.includes(fragment));
  });
}
