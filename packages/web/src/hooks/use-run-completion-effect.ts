import { useEffect, useRef } from "react";

/**
 * Run `onComplete` once each time `isRunning` transitions from `true` to
 * `false` — i.e. a chat run finishes. Never fires on mount (no transition yet)
 * nor when a run starts.
 *
 * Used by the ChatSwitcher to refetch the conversation list when the first
 * message of a new chat completes: the server derives the conversation title
 * from that first user message, but the switcher otherwise only refetches on
 * mount, on dropdown-open, or on an agent switch — so the title would not
 * appear until the user opened the list or navigated away and back.
 *
 * The callback is read through a ref so the effect depends only on `isRunning`
 * — swapping a non-memoized `onComplete` (common in components) never re-fires
 * it, and the latest callback is always the one invoked.
 */
export function useRunCompletionEffect(isRunning: boolean, onComplete: () => void): void {
  const wasRunning = useRef(isRunning);
  const onCompleteRef = useRef(onComplete);

  // Track the latest callback in an effect, not during render (writing a ref
  // mid-render is disallowed by the react-hooks "refs during render" rule).
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      onCompleteRef.current();
    }
    wasRunning.current = isRunning;
  }, [isRunning]);
}
