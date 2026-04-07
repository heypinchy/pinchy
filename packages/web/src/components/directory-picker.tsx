"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Folder } from "lucide-react";

interface Directory {
  path: string;
  name: string;
}

interface DirectoryPickerProps {
  directories: Directory[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function DirectoryPicker({ directories, selected, onChange }: DirectoryPickerProps) {
  if (directories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No directories available. Mount directories under <code>/data/</code> in your
        docker-compose.yml to make them accessible to agents.
      </p>
    );
  }

  function handleToggle(path: string) {
    if (selected.includes(path)) {
      onChange(selected.filter((p) => p !== path));
    } else {
      onChange([...selected, path]);
    }
  }

  return (
    <div className="space-y-3">
      {directories.map((dir) => (
        <div key={dir.path} className="flex items-center space-x-3">
          <Checkbox
            id={dir.path}
            checked={selected.includes(dir.path)}
            onCheckedChange={() => handleToggle(dir.path)}
            aria-label={dir.name}
          />
          <Label htmlFor={dir.path} className="flex items-center gap-2 cursor-pointer">
            <Folder className="size-4 text-muted-foreground" />
            <span>{dir.name}</span>
            <span className="text-xs text-muted-foreground">{dir.path}</span>
          </Label>
        </div>
      ))}
    </div>
  );
}
