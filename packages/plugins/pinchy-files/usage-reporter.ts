/**
 * Fire-and-forget reporter that sends aggregated vision API token usage
 * from the pinchy-files plugin to Pinchy's internal usage endpoint.
 *
 * Called after a PDF read that triggered one or more vision API calls.
 * The endpoint writes the numbers directly into the usage_records table
 * so they show up on the Usage Dashboard alongside chat tokens.
 *
 * Telemetry failures must never break PDF reads, so every error is caught
 * and logged. The caller should ignore the returned promise or use `void`.
 */

export interface UsageReport {
  agentId: string;
  agentName: string;
  sessionKey: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageReportConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

export async function reportUsage(
  report: UsageReport,
  config: UsageReportConfig,
): Promise<void> {
  if (report.inputTokens === 0 && report.outputTokens === 0) return;

  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/api/internal/usage/record`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.gatewayToken}`,
      },
      body: JSON.stringify({
        agentId: report.agentId,
        agentName: report.agentName,
        userId: "system",
        sessionKey: report.sessionKey,
        model: report.model,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `[pinchy-files] Usage report failed (${response.status}): ${text}`,
      );
    }
  } catch (err) {
    console.error("[pinchy-files] Usage report failed:", err);
  }
}
