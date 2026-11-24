import type { ReadonlyURLSearchParams } from "next/navigation";

// useSearchParams() is typed as ReadonlyURLSearchParams; a plain URLSearchParams
// is structurally not assignable (the readonly type drops the mutating methods)
// but is a valid value at runtime, so the mocks cast through it.
export const readonlySearchParams = (init?: string) =>
  new URLSearchParams(init) as unknown as ReadonlyURLSearchParams;
