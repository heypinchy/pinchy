// OpenClaw's system prompt tells the agent to name each file it hands over on
// a line of its own: `MEDIA:<path-or-url>`. Channels parse that line into an
// attachment. Pinchy's web chat delivers files a different way (the artifacts
// poll in stream-pipe, which renders a chip), so the line reaches the browser
// as plain reply text — showing an internal container path like
// `MEDIA:/root/.openclaw/workspaces/<id>/workbench/smoke.csv` (#1298).
//
// The rule mirrors OpenClaw's own parser (`splitMediaFromOutput`): a line whose
// first non-blank characters are `MEDIA:`, outside a code fence. One deliberate
// difference: OpenClaw matches case-insensitively and then validates the path;
// we match the upper-case directive only, which is how the prompt spells it, so
// a reply line like "Media: newspapers and radio" is never eaten.

const DIRECTIVE = "MEDIA:";

function isDirectiveLine(line: string): boolean {
  return line.trimStart().startsWith(DIRECTIVE);
}

/** True while `partial` (an unfinished line) could still turn into a directive. */
function couldBecomeDirective(partial: string): boolean {
  const start = partial.trimStart();
  return start.startsWith(DIRECTIVE) || DIRECTIVE.startsWith(start);
}

function isFenceLine(line: string): boolean {
  const start = line.trimStart();
  return start.startsWith("```") || start.startsWith("~~~");
}

export interface MediaDirectiveFilter {
  /** Feed a chunk; returns the text that is safe to emit now. */
  push(chunk: string): string;
  /** End of text; returns whatever was still held back. */
  flush(): string;
}

/**
 * Streaming form: a directive can arrive split across chunks (`ME` then
 * `DIA:/root/…`), so the current line is held back only while it could still
 * become one. Any other text is passed through as it arrives.
 */
export function createMediaDirectiveFilter(): MediaDirectiveFilter {
  let inFence = false;
  // The line being assembled, and how much of it has already been emitted.
  // Anything emitted means the line was judged not to be a directive.
  let line = "";
  let emitted = 0;

  function endLine(withNewline: boolean): string {
    const current = line;
    const alreadyEmitted = emitted;
    line = "";
    emitted = 0;
    if (!inFence && alreadyEmitted === 0 && isDirectiveLine(current)) return "";
    if (isFenceLine(current)) inFence = !inFence;
    return current.slice(alreadyEmitted) + (withNewline ? "\n" : "");
  }

  return {
    push(chunk) {
      let out = "";
      let rest = chunk;
      let nl: number;
      while ((nl = rest.indexOf("\n")) !== -1) {
        line += rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        out += endLine(true);
      }
      line += rest;
      const undecided = !inFence && emitted === 0 && couldBecomeDirective(line);
      if (!undecided && line.length > emitted) {
        out += line.slice(emitted);
        emitted = line.length;
      }
      return out;
    },
    flush() {
      return line ? endLine(false) : "";
    },
  };
}

/** Whole-string form, for history replies that arrive complete. */
export function stripMediaDirectives(text: string): string {
  if (!text.includes(DIRECTIVE)) return text;
  const filter = createMediaDirectiveFilter();
  return filter.push(text) + filter.flush();
}
