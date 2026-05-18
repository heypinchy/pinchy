import Link from "next/link";
import { getModelDisplayName } from "@/lib/model-display-name";

interface SmithersModelInfoLineProps {
  modelId: string;
}

export function SmithersModelInfoLine({ modelId }: SmithersModelInfoLineProps) {
  return (
    <p className="text-sm text-muted-foreground mt-2">
      Smithers will use {getModelDisplayName(modelId)}. You can change this in{" "}
      <Link href="/settings/agents" className="underline">
        Agent Settings
      </Link>
      .
    </p>
  );
}
