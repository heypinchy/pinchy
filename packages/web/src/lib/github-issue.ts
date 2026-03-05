export interface DiagnosticsResult {
  database: "connected" | "unreachable";
  openclaw: "connected" | "unreachable";
  version: string;
  nodeEnv: string;
  logs?: string;
}

export interface IssueContext {
  error: string;
  statusCode?: number;
  page: string;
  diagnostics?: DiagnosticsResult;
}

const REPO_URL = "https://github.com/heypinchy/pinchy/issues/new";
const MAX_TITLE_LENGTH = 80;

function buildTitle(error: string): string {
  const truncatedError = error.length > 60 ? error.slice(0, 57) + "..." : error;
  return `Error: ${truncatedError}`.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Returns a GitHub new-issue URL with only the title and a short paste hint.
 * The full issue body should be copied to clipboard separately via buildIssueBody().
 */
export function buildGitHubIssueUrl(context: IssueContext): string {
  const title = buildTitle(context.error);
  const body =
    "**Paste your clipboard below** (Cmd+V / Ctrl+V) — diagnostic info was copied automatically.\n\n---\n";

  const params = new URLSearchParams({ title, body });
  return `${REPO_URL}?${params.toString()}`;
}

/**
 * Returns a GitHub new-issue URL for general bug reports (no specific error).
 * Environment info and steps-to-reproduce hint are embedded in URL params.
 */
export function buildBugReportUrl(page: string): string {
  const body = [
    "**Environment:**",
    `- Browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- Pinchy: ${process.env.NEXT_PUBLIC_PINCHY_VERSION ?? "unknown"}`,
    `- Page: ${page}`,
    "",
    "**Steps to reproduce:** *(please describe what you did before the error occurred)*",
    "1. ",
    "",
    "**What happened:**",
    "",
    "",
    "**What you expected:**",
    "",
  ].join("\n");

  const params = new URLSearchParams({ body, labels: "bug" });
  return `${REPO_URL}?${params.toString()}`;
}

/**
 * Builds the full issue body text for copying to clipboard.
 * Contains error details, environment info, diagnostics, and log instructions.
 */
export function buildIssueBody(context: IssueContext): string {
  const { error, statusCode, page, diagnostics } = context;

  const errorSuffix = statusCode ? ` (HTTP ${statusCode})` : "";

  const sections: string[] = [
    `**Error:** ${error}${errorSuffix}`,
    "",
    "**Environment:**",
    `- Browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- Pinchy: ${process.env.NEXT_PUBLIC_PINCHY_VERSION ?? "unknown"}`,
    `- Page: ${page}`,
  ];

  if (diagnostics) {
    sections.push(
      "",
      "**Server Diagnostics:**",
      `- Database: ${diagnostics.database}`,
      `- OpenClaw: ${diagnostics.openclaw}`,
      `- Version: ${diagnostics.version}`,
      `- Node env: ${diagnostics.nodeEnv}`
    );
  }

  sections.push(
    "",
    "**Steps to reproduce:** *(please describe what you did before the error occurred)*",
    "1. "
  );

  if (diagnostics?.logs) {
    sections.push("", "**Logs:**", "```", diagnostics.logs, "```");
  } else {
    sections.push(
      "",
      "**Logs:** (run `docker compose logs pinchy --tail 200` and paste below)",
      "```",
      "",
      "```"
    );
  }

  return sections.join("\n");
}

const DIAGNOSTICS_TIMEOUT_MS = 3000;

export async function fetchDiagnostics(): Promise<DiagnosticsResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIAGNOSTICS_TIMEOUT_MS);

    const res = await fetch("/api/diagnostics", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    return (await res.json()) as DiagnosticsResult;
  } catch {
    return null;
  }
}
