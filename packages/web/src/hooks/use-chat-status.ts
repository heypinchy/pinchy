import { useEffect, useState } from "react";

export type UnavailableReason = "disconnected" | "configuring" | "exhausted";
export type ChatStatus =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "responding" }
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
  configuring: boolean;
}

const DISCONNECT_HYSTERESIS_MS = 2000;

export function useChatStatus(inputs: ChatStatusInputs): ChatStatus {
  const fullyConnected = inputs.isConnected && inputs.isOpenClawConnected;
  const [delayedDisconnect, setDelayedDisconnect] = useState(false);

  useEffect(() => {
    if (fullyConnected) {
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
  }, [fullyConnected, inputs.configuring, inputs.reconnectExhausted]);

  if (inputs.reconnectExhausted) return { kind: "unavailable", reason: "exhausted" };
  if (inputs.configuring) return { kind: "unavailable", reason: "configuring" };
  if (!fullyConnected && delayedDisconnect) return { kind: "unavailable", reason: "disconnected" };
  if (!inputs.isHistoryLoaded || !inputs.hasInitialContent) return { kind: "starting" };
  if (inputs.isRunning) return { kind: "responding" };
  return { kind: "ready" };
}
