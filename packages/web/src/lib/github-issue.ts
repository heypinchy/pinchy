export interface DiagnosticsResult {
  database: "connected" | "unreachable";
  openclaw: "connected" | "unreachable";
  version: string;
  nodeEnv: string;
}

export interface IssueContext {
  error: string;
  statusCode?: number;
  page: string;
  diagnostics?: DiagnosticsResult;
}

const REPO_URL = "https://github.com/heypinchy/pinchy/issues/new";
const MAX_TITLE_LENGTH = 80;

export function buildGitHubIssueUrl(context: IssueContext): string {
  const { error, statusCode, page, diagnostics } = context;

  const errorSuffix = statusCode ? ` (HTTP ${statusCode})` : "";
  const truncatedError = error.length > 60 ? error.slice(0, 57) + "..." : error;
  const title = `Setup error: ${truncatedError}`.slice(0, MAX_TITLE_LENGTH);

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
    "**Steps to reproduce:**",
    "1. ",
    "",
    "**Logs:** (run `docker compose logs pinchy --tail 200` and paste below)",
    "```",
    "",
    "```"
  );

  const body = sections.join("\n");
  const params = new URLSearchParams({ title, body });
  return `${REPO_URL}?${params.toString()}`;
}
