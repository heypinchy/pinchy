import { createHash } from "node:crypto";
import type { AgentConfigSnapshot } from "./agent-config-collector";
import type { OtelSpan } from "./otel-builder";

export interface BundleInput {
  spans: OtelSpan[];
  versions: { pinchy: string; openclaw: string; openclawNode: string };
  agentConfig: AgentConfigSnapshot;
  scope: {
    agentId: string;
    sessionKey: string;
    /**
     * 1-based count of turns included up to and through the anchor turn.
     * `null` when no anchor (Settings-triggered exports include the last N
     * turns of the session). `skippedTurnsAfterAnchor` is then computed as
     * `sessionTurnCount - anchorTurnIndex`. Reminder: this is a count, not
     * a 0-based array index — passing a 0-based index will over-report
     * skipped turns by one.
     */
    anchorTurnIndex: number | null;
    sessionTurnCount: number;
    includedTurnRange: [number, number];
  };
  auditEntries: unknown[];
  userDescription?: string;
}

export interface Bundle {
  schemaVersion: "pinchy.bugreport.v1";
  generatedAt: string;
  pinchyVersion: string;
  openclawVersion: string;
  openclawNodeVersion: string;
  scope: {
    agentId: string;
    sessionKeyHash: string;
    anchorTurnIndex: number | null;
    sessionTurnCount: number;
    includedTurnRange: [number, number];
    skippedTurnsAfterAnchor: number;
  };
  userDescription?: string;
  agentConfig: AgentConfigSnapshot;
  spans: OtelSpan[];
  auditEntries: unknown[];
}

export function buildBundle(input: BundleInput): Bundle {
  const hash = "sha256:" + createHash("sha256").update(input.scope.sessionKey).digest("hex");
  const anchor = input.scope.anchorTurnIndex;
  const skipped = anchor !== null ? Math.max(0, input.scope.sessionTurnCount - anchor) : 0;
  return {
    schemaVersion: "pinchy.bugreport.v1",
    generatedAt: new Date().toISOString(),
    pinchyVersion: input.versions.pinchy,
    openclawVersion: input.versions.openclaw,
    openclawNodeVersion: input.versions.openclawNode,
    scope: {
      agentId: input.scope.agentId,
      sessionKeyHash: hash,
      anchorTurnIndex: anchor,
      sessionTurnCount: input.scope.sessionTurnCount,
      includedTurnRange: input.scope.includedTurnRange,
      skippedTurnsAfterAnchor: skipped,
    },
    ...(input.userDescription ? { userDescription: input.userDescription } : {}),
    agentConfig: input.agentConfig,
    spans: input.spans,
    auditEntries: input.auditEntries,
  };
}
