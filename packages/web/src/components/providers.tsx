"use client";

import { RestartProvider } from "@/components/restart-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return <RestartProvider>{children}</RestartProvider>;
}
