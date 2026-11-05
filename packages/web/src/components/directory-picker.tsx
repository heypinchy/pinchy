"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Folder, FolderOpen } from "lucide-react";
import { isSameDirectory } from "@/lib/directory-path";

interface Directory {
  path: string;
  name: string;
}

interface DirectoryPickerProps {
  directories: Directory[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Accessible name of the group — the visible heading it sits under. */
  label?: string;
}

export function DirectoryPicker({ directories, selected, onChange, label }: DirectoryPickerProps) {
  const idPrefix = useId();

  if (directories.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <FolderOpen className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          No directories available yet. Mount directories under <code>/data/</code> in your
          docker-compose.yml to make them available to agents.
        </p>
      </div>
    );
  }

  // A grant may be stored as "/data/x/" while the list says "/data/x" (#1264).
  const isSelected = (path: string) => selected.some((p) => isSameDirectory(p, path));
  const selectedCount = directories.filter((dir) => isSelected(dir.path)).length;

  function handleToggle(path: string) {
    if (isSelected(path)) {
      onChange(selected.filter((p) => !isSameDirectory(p, path)));
    } else {
      onChange([...selected, path]);
    }
  }

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="divide-y overflow-hidden rounded-lg border">
        {directories.map((dir, index) => {
          const checkboxId = `${idPrefix}-dir-${index}`;
          const pathId = `${checkboxId}-path`;
          const checked = isSelected(dir.path);
          return (
            <div key={dir.path}>
              {/* The whole row is the hit target, not just the 16px box. */}
              <label
                htmlFor={checkboxId}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50 has-[:focus-visible]:bg-muted/50"
              >
                <Checkbox
                  id={checkboxId}
                  checked={checked}
                  onCheckedChange={() => handleToggle(dir.path)}
                  aria-label={dir.name}
                  aria-describedby={pathId}
                />
                <Folder
                  className={`size-4 shrink-0 ${checked ? "text-foreground" : "text-muted-foreground"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{dir.name}</span>
                  <span id={pathId} className="block break-all text-xs text-muted-foreground">
                    {dir.path}
                  </span>
                </span>
              </label>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedCount} of {directories.length} selected
      </p>
    </div>
  );
}
