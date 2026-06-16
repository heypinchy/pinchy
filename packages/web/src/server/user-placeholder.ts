/**
 * Resolves the `{user}` placeholder in agent greeting/system text.
 *
 * When a user name is known, every `{user}` becomes that name. When it is not
 * (anonymous / name-less user), the placeholder is stripped along with the
 * punctuation that was meant to set it off — so a greeting authored as
 * "Hi, {user}!" reads as "Hi!" rather than "Hi, !". The two-step replace
 * removes a leading ", {user}" run first, then any bare "{user}" with trailing
 * comma/period and whitespace.
 *
 * Pure and deterministic — extracted from ClientRouter so the substitution
 * contract can be unit-tested directly rather than only through the chat flow.
 */
export function resolveUserPlaceholder(text: string, userName: string | null | undefined): string {
  if (userName) {
    return text.replace(/\{user\}/g, userName);
  }
  // Remove ", {user}" patterns first, then any remaining "{user}" with trailing punctuation
  return text.replace(/,\s*\{user\}/g, "").replace(/\{user\}[,.]?\s*/g, "");
}
