import { AlertTriangle } from "lucide-react";
import type { FC } from "react";

export interface ChatError {
  agentName?: string;
  providerError?: string;
  hint?: string | null;
  message?: string;
}

export const ChatErrorMessage: FC<{ error: ChatError }> = ({ error }) => {
  const isProviderError = !!error.providerError;

  return (
    <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm dark:bg-destructive/5">
      {isProviderError ? (
        <>
          <div className="flex items-center gap-2 font-medium text-destructive dark:text-red-200">
            <AlertTriangle className="size-4 shrink-0" data-testid="error-warning-icon" />
            {error.agentName} couldn&apos;t respond
          </div>
          <p className="mt-1.5 text-destructive/90 dark:text-red-300/90">{error.providerError}</p>
          {error.hint && (
            <p className="mt-1.5 text-destructive/75 dark:text-red-300/75">{error.hint}</p>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 text-destructive dark:text-red-200">
          <AlertTriangle className="size-4 shrink-0" data-testid="error-warning-icon" />
          {error.message}
        </div>
      )}
    </div>
  );
};
