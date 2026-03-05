"use client";

import { ReportIssueLink } from "@/components/report-issue-link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              maxWidth: "28rem",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "1.5rem",
              padding: "0 1rem",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} />

            <div style={{ textAlign: "center" }}>
              <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", margin: "0 0 0.5rem 0" }}>
                Something went wrong
              </h1>
              <p style={{ fontSize: "0.875rem", color: "#6b7280", margin: 0 }}>{error.message}</p>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  fontSize: "0.875rem",
                  color: "#6b7280",
                  background: "none",
                  border: "none",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              <ReportIssueLink error={error.message} />
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
