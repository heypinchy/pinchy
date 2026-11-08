/**
 * Drift guard: no workflow step pipes a download into a shell.
 *
 * `curl -fsSL https://ollama.com/install.sh | sh` looks safe because of the
 * `-f`. It is not. GitHub runs an unspecified `run:` shell as `bash -e {0}` —
 * no `pipefail` — so a pipeline's status is its LAST command's. When
 * ollama.com answered 504, curl exited 22 with nothing on stdout, `sh` ran an
 * empty script and exited 0, and the step's retry loop took that as success.
 * The next step then failed on `ollama: command not found`, naming the wrong
 * step, and the retry written for exactly this outage never fired (run
 * 42473085435, PR #1395).
 *
 * `set -o pipefail` would fix the exit status but not the worse half: by the
 * time curl fails mid-body, `sh` has already executed the part it received.
 * So the rule is the shape, not the option: download to a file, run the
 * file, then check the thing it was meant to install exists.
 *
 * Textual, like the other workflow guards here: comments are stripped first
 * (these files explain their steps in prose, and a comment quoting the bad
 * shape must not read as the bad shape), backslash continuations are joined,
 * and a command is split at `;` / `&&` / `||` before its pipes are read, so a
 * `curl … || sh fallback.sh` is not a pipe.
 */

const FETCHER = /(^|[\s/])(curl|wget)(\s|$)/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** Removes a shell/YAML comment: `#` at line start or after whitespace. */
function stripComment(line) {
  return line.replace(/(^|\s)#.*$/, "$1");
}

/** The program a pipeline stage runs, past `sudo`, `env` and VAR=value. */
function stageProgram(stage) {
  const tokens = stage.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const base = t.split("/").pop();
    if (base === "sudo" || base === "env") {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    return base;
  }
  return "";
}

/**
 * Finds every download piped into a shell in a workflow/action file's text.
 *
 * @param {string} text
 * @returns {Array<{ line: number, text: string }>} 1-based line of the
 *   offending logical line's start, and that line's source text
 */
export function findPipedDownloads(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const hits = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let logical = stripComment(lines[i]);
    while (/\\\s*$/.test(logical) && i + 1 < lines.length) {
      i++;
      logical = logical.replace(/\\\s*$/, " ") + stripComment(lines[i]);
    }
    i++;
    const commands = logical.split(/;|&&|\|\||\bthen\b|\bdo\b/);
    const piped = commands.some((command) => {
      const stages = command.split("|");
      const fetchAt = stages.findIndex((s) => FETCHER.test(s));
      if (fetchAt === -1) return false;
      return stages.slice(fetchAt + 1).some((s) => SHELLS.has(stageProgram(s)));
    });
    if (piped) hits.push({ line: start + 1, text: lines[start] });
  }
  return hits;
}
