import { Button } from "@/components/ui/button";

interface RetryButtonProps {
  onClick: () => void;
  disabled: boolean;
}

export function RetryButton({ onClick, disabled }: RetryButtonProps) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={disabled}>
      Retry
    </Button>
  );
}
