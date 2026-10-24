import { cn } from "@/lib/utils";

/**
 * A group heading inside a settings sidebar (`TabsList variant="sidebar"`).
 *
 * Shared by the global Settings and Agent Settings so the two navigations
 * cannot drift apart visually. `role="presentation"` keeps it out of the
 * tablist's accessible children — it labels a group of tabs, it is not one.
 * The first group sits flush with the top; every later one gets the gap that
 * separates it from the group above.
 */
export function SettingsNavGroupLabel({
  children,
  first = false,
}: {
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div
      role="presentation"
      className={cn(
        "text-muted-foreground/70 px-2 pb-1 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase",
        first ? "pt-1" : "pt-6"
      )}
    >
      {children}
    </div>
  );
}
