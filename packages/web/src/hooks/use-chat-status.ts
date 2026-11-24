import { useEffect, useState } from "react";
import type { ConnectionRejection } from "@/hooks/use-ws-runtime";

export type UnavailableReason =
  | "disconnected"
  | "offline"
  | "rejected"
  | "upstreamDown"
  | "unreachable"
  | "configuring"
  | "historyTimeout";
export type ChatStatus =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "responding" }
  | { kind: "payloadRejected" }
  /**
   * `escalated` is set once the outage has outlived ESCALATION_MS. It changes
   * what we say about an `upstreamDown`, never whether we keep retrying.
   */
  | { kind: "unavailable"; reason: UnavailableReason; escalated?: true };

export interface ChatStatusInputs {
  isConnected: boolean;
  isOpenClawConnected: boolean;
  isHistoryLoaded: boolean;
  /**
   * True once there is something renderable in the chat — at least one
   * message, or an authoritative "session known but empty" signal from the
   * server. Gates the transition out of "starting" so the indicator never
   * turns green before the initial greeting/history is on screen (issue #197).
   */
  hasInitialContent: boolean;
  isRunning: boolean;
  /** The browser reports no network. */
  isOffline: boolean;
  /** The server refused the last connection and said why (close 4429). */
  connectionRejection: ConnectionRejection | null;
  payloadRejected: boolean;
  /**
   * The deadline on the wait for a `history` frame expired (issue #956). Only
   * meaningful while `hasInitialContent` is false: that combination is the dead
   * end the user reported — a chat parked on the loading indicator with no
   * error, no timeout and no way out but a manual reload. Once anything is
   * renderable, a late/lost catch-up pull is not worth blanking the transcript
   * for, so it is ignored.
   */
  historyTimedOut: boolean;
  configuring: boolean;
}

const DISCONNECT_HYSTERESIS_MS = 2000;
/** Continuous unavailability after which the message gets louder (#1422). */
export const ESCALATION_MS = 30_000;

export function useChatStatus(inputs: ChatStatusInputs): ChatStatus {
  const fullyConnected = inputs.isConnected && inputs.isOpenClawConnected;
  const [delayedDisconnect, setDelayedDisconnect] = useState(false);
  const [escalated, setEscalated] = useState(false);

  useEffect(() => {
    if (fullyConnected || inputs.payloadRejected) {
      // setTimeout(0) is required: calling setState synchronously inside an
      // effect body triggers the react-hooks/set-state-in-effect ESLint rule.
      // The negligible delay is imperceptible to users. The cleanup cancels
      // the timer if the effect re-runs before it fires (e.g. rapid
      // fullyConnected toggling).
      const t = setTimeout(() => setDelayedDisconnect(false), 0);
      return () => clearTimeout(t);
    }
    if (inputs.configuring || inputs.isOffline || inputs.connectionRejection) return;
    const t = setTimeout(() => setDelayedDisconnect(true), DISCONNECT_HYSTERESIS_MS);
    return () => clearTimeout(t);
  }, [
    fullyConnected,
    inputs.configuring,
    inputs.isOffline,
    inputs.connectionRejection,
    inputs.payloadRejected,
  ]);

  // The escalation clock runs while nothing is serving us and the cause is not
  // one the user already has a better word for. It is keyed on `fullyConnected`
  // alone, so a socket that opens and is refused or drops again does not
  // restart it — only being served does.
  const counting = !fullyConnected && !inputs.configuring && !inputs.isOffline;
  useEffect(() => {
    if (!counting) {
      const t = setTimeout(() => setEscalated(false), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setEscalated(true), ESCALATION_MS);
    return () => clearTimeout(t);
  }, [counting]);

  if (inputs.isOffline) return { kind: "unavailable", reason: "offline" };
  if (inputs.connectionRejection) return { kind: "unavailable", reason: "rejected" };
  if (inputs.configuring) return { kind: "unavailable", reason: "configuring" };
  if (inputs.payloadRejected) return { kind: "payloadRejected" };
  // Ranked ABOVE "disconnected": the self-heal that follows the deadline closes
  // the socket, so isConnected drops moments later. Letting the generic
  // "Reconnecting..." win would hide the retry affordance behind exactly the
  // recovery attempt the user is waiting on.
  if (inputs.historyTimedOut && !inputs.hasInitialContent) {
    return { kind: "unavailable", reason: "historyTimeout" };
  }
  if (!fullyConnected && delayedDisconnect) {
    // Socket open but the agent runtime behind it is not: a different problem
    // from a socket that will not open, with different advice.
    if (inputs.isConnected) {
      return escalated
        ? { kind: "unavailable", reason: "upstreamDown", escalated: true }
        : { kind: "unavailable", reason: "upstreamDown" };
    }
    return { kind: "unavailable", reason: escalated ? "unreachable" : "disconnected" };
  }
  if (!inputs.isHistoryLoaded || !inputs.hasInitialContent) return { kind: "starting" };
  if (inputs.isRunning) return { kind: "responding" };
  return { kind: "ready" };
}
