import { createHash } from "node:crypto";
import type { OtelSpan } from "./otel-builder";

export interface BundleInput {
  spans: OtelSpan[];
  versions: { pinchy: string; openclaw: string; openclawNode: string };
  scope: {
    agentId: string;
    sessionKey: string;
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
    spans: input.spans,
    auditEntries: input.auditEntries,
  };
}
