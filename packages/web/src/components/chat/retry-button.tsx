import { useContext } from "react";
import { ChatStatusContext } from "@/components/chat";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RetryButtonProps {
  onClick: () => void;
}

export function RetryButton({ onClick }: RetryButtonProps) {
  const status = useContext(ChatStatusContext);
  const disabled = status.kind !== "ready";
  const loading = status.kind === "responding";
  const tooltip =
    status.kind === "unavailable"
      ? "Agent unavailable"
      : status.kind === "responding"
        ? "Waiting for the current response"
        : status.kind === "starting"
          ? "Agent is starting up"
          : undefined;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-red-300/40 dark:text-red-200 dark:hover:bg-red-900/20 dark:hover:text-red-200"
    >
      <RotateCw className={`size-3.5${loading ? " animate-spin" : ""}`} aria-hidden="true" />
      Retry
    </Button>
  );
}
