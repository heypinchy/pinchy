import { useEffect, useState } from "react";

export type UnavailableReason = "disconnected" | "configuring" | "exhausted" | "historyTimeout";
export type ChatStatus =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "responding" }
  | { kind: "payloadRejected" }
  | { kind: "unavailable"; reason: UnavailableReason };

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
  reconnectExhausted: boolean;
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

export function useChatStatus(inputs: ChatStatusInputs): ChatStatus {
  const fullyConnected = inputs.isConnected && inputs.isOpenClawConnected;
  const [delayedDisconnect, setDelayedDisconnect] = useState(false);

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
    if (inputs.configuring || inputs.reconnectExhausted) return;
    const t = setTimeout(() => setDelayedDisconnect(true), DISCONNECT_HYSTERESIS_MS);
    return () => clearTimeout(t);
  }, [fullyConnected, inputs.configuring, inputs.reconnectExhausted, inputs.payloadRejected]);

  if (inputs.reconnectExhausted) return { kind: "unavailable", reason: "exhausted" };
  if (inputs.configuring) return { kind: "unavailable", reason: "configuring" };
  if (inputs.payloadRejected) return { kind: "payloadRejected" };
  // Ranked ABOVE "disconnected": the self-heal that follows the deadline closes
  // the socket, so isConnected drops moments later. Letting the generic
  // "Reconnecting..." win would hide the retry affordance behind exactly the
  // recovery attempt the user is waiting on.
  if (inputs.historyTimedOut && !inputs.hasInitialContent) {
    return { kind: "unavailable", reason: "historyTimeout" };
  }
  if (!fullyConnected && delayedDisconnect) return { kind: "unavailable", reason: "disconnected" };
  if (!inputs.isHistoryLoaded || !inputs.hasInitialContent) return { kind: "starting" };
  if (inputs.isRunning) return { kind: "responding" };
  return { kind: "ready" };
}
