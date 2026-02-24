"use client";

import { SessionProvider } from "next-auth/react";
import { RestartProvider } from "@/components/restart-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <RestartProvider>{children}</RestartProvider>
    </SessionProvider>
  );
}
