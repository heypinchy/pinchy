"use client";

import * as React from "react";
import { Input } from "./input";
import { normalizeUrl } from "@/lib/url";

/**
 * Input variant that auto-normalizes URLs onBlur:
 *  - prepends `https://` when no protocol is present
 *  - strips path / query / fragment to the bare origin
 *
 * Renders as `type="text"` (not `type="url"`) on purpose. Native URL inputs
 * block form submission when the value lacks a protocol — which is the
 * exact UX trap we want to fix (users pasting bare hostnames).
 *
 * Pairs with react-hook-form via the standard `{...field}` spread: when
 * normalization changes the value, we dispatch a synthetic onChange so the
 * form state stays in sync.
 */
export function UrlInput({ onBlur, onChange, ...props }: React.ComponentProps<typeof Input>) {
  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const normalized = normalizeUrl(raw);

    if (normalized && normalized !== raw) {
      // Mutate the input value, then fire onChange so react-hook-form (and
      // any other controlled-input consumer) picks up the normalized value.
      event.target.value = normalized;
      const syntheticEvent = {
        ...event,
        target: event.target,
        currentTarget: event.currentTarget,
      } as React.ChangeEvent<HTMLInputElement>;
      onChange?.(syntheticEvent);
    }

    onBlur?.(event);
  }

  return (
    <Input
      type="text"
      inputMode="url"
      autoComplete="url"
      spellCheck={false}
      onBlur={handleBlur}
      onChange={onChange}
      {...props}
    />
  );
}
