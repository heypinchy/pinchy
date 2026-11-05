"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ChevronRight, Folder } from "lucide-react";
import { apiGet } from "@/lib/api-client";
import { directoryKey as key } from "@/lib/directory-path";

interface Directory {
  path: string;
  name: string;
}

export interface DirectoryChildren {
  directories: Directory[];
  truncated: boolean;
}

interface DirectoryPickerProps {
  /** The top-level `/data` mounts, from `GET /api/data-directories`. */
  directories: Directory[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /**
   * Whether folders can be opened to grant a subfolder. The listing route is
   * admin-only. Every surface that renders the picker today is admin-only too
   * (the new-agent form, and the Permissions tab of a shared agent), so this
   * is defence in depth: a future non-admin surface gets the mounts and its
   * grants, not chevrons that could only ever answer 403.
   */
  browseSubfolders?: boolean;
  /** One level of subfolders. Defaults to `GET /api/data-directories/children`; tests inject it. */
  loadChildren?: (path: string) => Promise<DirectoryChildren>;
}

function fetchChildren(path: string): Promise<DirectoryChildren> {
  return apiGet<DirectoryChildren>(
    `/api/data-directories/children?path=${encodeURIComponent(path)}`
  );
}

/** Strictly below — `/data/suppliers-archive` is not inside `/data/suppliers`. */
function isInside(path: string, folder: string): boolean {
  return key(path).startsWith(key(folder) + "/");
}

type ChildState =
  { status: "loading" } | { status: "error" } | ({ status: "loaded" } & DirectoryChildren);

/**
 * Folder picker for `pinchy-files.allowed_paths`.
 *
 * Mounts are listed up front; their subfolders load one level at a time when a
 * folder is opened (#1269), because a share can hold far more folders than any
 * page should walk. Granting a folder grants everything below it — the plugin
 * and the index both treat a grant as a prefix — so:
 *
 *   - the subfolders of a granted folder show as included and cannot be ticked
 *     separately, and
 *   - granting a folder drops the grants already below it, so the stored list
 *     says the same thing with fewer entries.
 *
 * A grant below a mount opens its parents on its own, so what an agent can
 * read is visible without anyone hunting for it. A grant the picker cannot
 * find at all (a share that is gone, a renamed folder) is listed separately
 * rather than hidden, so it can still be revoked.
 */
export function DirectoryPicker({
  directories,
  selected,
  onChange,
  browseSubfolders = true,
  loadChildren = fetchChildren,
}: DirectoryPickerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, ChildState>>(() => new Map());
  const requested = useRef(new Set<string>());
  // Grants whose parents were already opened for the admin. Once is enough:
  // re-opening on every change would undo a folder the admin just closed.
  const revealed = useRef(new Set<string>());

  const selectedKeys = useMemo(() => new Set(selected.map(key)), [selected]);

  function load(path: string) {
    const k = key(path);
    if (requested.current.has(k)) return;
    requested.current.add(k);
    setChildren((prev) => new Map(prev).set(k, { status: "loading" }));
    loadChildren(k).then(
      (result) =>
        setChildren((prev) =>
          new Map(prev).set(k, {
            status: "loaded",
            directories: result.directories,
            truncated: result.truncated,
          })
        ),
      () => {
        // Let a second open retry instead of pinning the error forever.
        requested.current.delete(k);
        setChildren((prev) => new Map(prev).set(k, { status: "error" }));
      }
    );
  }

  // Open every folder between a mount and a grant below it.
  useEffect(() => {
    if (!browseSubfolders) return;
    const toOpen: string[] = [];
    for (const grant of selected) {
      const mount = directories.find((dir) => isInside(grant, dir.path));
      if (!mount || revealed.current.has(key(grant))) continue;
      revealed.current.add(key(grant));
      const below = key(grant)
        .slice(key(mount.path).length + 1)
        .split("/");
      let folder = key(mount.path);
      for (const segment of below.slice(0, -1)) {
        toOpen.push(folder);
        folder = `${folder}/${segment}`;
      }
      toOpen.push(folder);
    }
    if (toOpen.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      toOpen.forEach((folder) => next.add(folder));
      return next;
    });
    toOpen.forEach(load);
    // `load` is stable in behaviour (guarded by `requested`); re-running on
    // every render would only re-check the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, directories, browseSubfolders]);

  if (directories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No directories available. Mount directories under <code>/data/</code> in your
        docker-compose.yml to make them accessible to agents.
      </p>
    );
  }

  function toggle(path: string) {
    const k = key(path);
    if (selectedKeys.has(k)) {
      onChange(selected.filter((p) => key(p) !== k));
    } else {
      onChange([...selected.filter((p) => !isInside(p, k)), path]);
    }
  }

  function toggleExpanded(path: string) {
    const k = key(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    if (!expanded.has(k)) load(k);
  }

  /** The granted folder that already covers `path`, if any. */
  function coveringGrant(path: string): string | undefined {
    return selected.find((grant) => isInside(path, grant));
  }

  // A grant is "found" once the folder that should list it has been listed
  // and does. Until then it is shown where it belongs, as soon as that loads.
  // Walked down from the mounts, not collected from every loaded listing:
  // ancestors of a grant load in parallel, so a folder can be listed while
  // the level above it does not list IT (cut from a truncated listing, or
  // hidden) — and a grant inside such a folder is in no row anyone can reach.
  const shownKeys = new Set(directories.map((dir) => key(dir.path)));
  const toWalk = [...shownKeys];
  for (let folder = toWalk.pop(); folder !== undefined; folder = toWalk.pop()) {
    const state = children.get(folder);
    if (state?.status !== "loaded") continue;
    for (const child of state.directories) {
      const childKey = key(child.path);
      if (shownKeys.has(childKey)) continue;
      shownKeys.add(childKey);
      toWalk.push(childKey);
    }
  }
  const missing = selected.filter((grant) => {
    const k = key(grant);
    if (shownKeys.has(k)) return false;
    if (!browseSubfolders) return true;
    const parent = k.slice(0, k.lastIndexOf("/"));
    const mount = directories.find((dir) => isInside(grant, dir.path));
    if (!mount) return true;
    const parentState = children.get(parent);
    return parentState?.status === "loaded" || parentState?.status === "error";
  });

  function renderFolder(dir: Directory, depth: number) {
    const k = key(dir.path);
    const isOpen = expanded.has(k);
    const cover = coveringGrant(dir.path);
    const checked = cover !== undefined || selectedKeys.has(k);
    const state = children.get(k);

    return (
      <li key={k}>
        <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 1.5}rem` }}>
          {browseSubfolders && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={`${isOpen ? "Hide" : "Show"} subfolders of ${dir.name}`}
              aria-expanded={isOpen}
              onClick={() => toggleExpanded(dir.path)}
            >
              <ChevronRight
                className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            </button>
          )}
          <Checkbox
            id={`dir-${k}`}
            checked={checked}
            disabled={cover !== undefined}
            onCheckedChange={() => toggle(dir.path)}
            aria-label={dir.name}
          />
          <Label
            htmlFor={`dir-${k}`}
            className={`flex items-center gap-2 ${cover ? "" : "cursor-pointer"}`}
          >
            <Folder className="size-4 text-muted-foreground" />
            <span>{dir.name}</span>
            {depth === 0 && <span className="text-xs text-muted-foreground">{dir.path}</span>}
            {cover && (
              <span className="text-xs text-muted-foreground">
                Included with {cover.replace(/\/+$/, "").split("/").pop()}
              </span>
            )}
          </Label>
        </div>
        {isOpen && (
          <div style={{ paddingLeft: `${(depth + 1) * 1.5 + 1.75}rem` }}>
            {(!state || state.status === "loading") && (
              <p className="py-1 text-xs text-muted-foreground">Loading…</p>
            )}
            {state?.status === "error" && (
              <p className="py-1 text-xs text-destructive">
                Couldn&apos;t load the subfolders. Close and open the folder to try again.
              </p>
            )}
            {state?.status === "loaded" && state.directories.length === 0 && (
              <p className="py-1 text-xs text-muted-foreground">No subfolders</p>
            )}
          </div>
        )}
        {isOpen && state?.status === "loaded" && state.directories.length > 0 && (
          <>
            <ul className="mt-2 space-y-2">
              {state.directories.map((child) => renderFolder(child, depth + 1))}
            </ul>
            {state.truncated && (
              <p
                className="py-1 text-xs text-muted-foreground"
                style={{ paddingLeft: `${(depth + 1) * 1.5 + 1.75}rem` }}
              >
                Showing only the first {state.directories.length} subfolders.
              </p>
            )}
          </>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3">{directories.map((dir) => renderFolder(dir, 0))}</ul>
      {missing.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {browseSubfolders
              ? "Also granted, but not found in the folders above:"
              : "Also granted:"}
          </p>
          <ul className="space-y-2">
            {missing.map((grant) => {
              const label = key(grant);
              return (
                <li key={label} className="flex items-center gap-3">
                  <Checkbox
                    id={`missing-${label}`}
                    checked
                    onCheckedChange={() => toggle(grant)}
                    aria-label={label}
                  />
                  <Label htmlFor={`missing-${label}`} className="cursor-pointer text-sm">
                    {label}
                  </Label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
