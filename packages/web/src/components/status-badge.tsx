import { Badge } from "@/components/ui/badge";

const variants: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  expired: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  deactivated: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={`text-xs ${variants[status] || ""}`}>
      {status}
    </Badge>
  );
}
