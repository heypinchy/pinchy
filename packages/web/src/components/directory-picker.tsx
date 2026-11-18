"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { apiGet } from "@/lib/api-client";
import { directoryKey as key } from "@/lib/directory-path";
import { DocsLink } from "@/components/docs-link";
import { Button } from "@/components/ui/button";
import type { GrantedFolder, GrantedFolderStatus } from "@/lib/granted-folder-status";

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
  /** Accessible name of the group — the visible heading it sits under. */
  label?: string;
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
  /**
   * Whether each saved grant's folder still exists, from
   * `GET /api/agents/:id/granted-folders`. Without it (a new agent, a member)
   * grants are shown as they are stored.
   */
  grantedFolders?: GrantedFolder[];
}

/** What to say beside a grant whose folder isn't simply there (#1363). */
const STATUS_NOTE: Partial<Record<GrantedFolderStatus, string>> = {
  missing: "Folder not found. It may have been renamed or removed.",
  unreadable: "Pinchy can't open this folder. Check its permissions on the server.",
  link: "This is a symbolic link. Agents can't read through links.",
};

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
 *
 * When the caller knows which grants still exist (`grantedFolders`), a grant
 * whose folder is gone offers one action — Remove — instead of a ticked box
 * that reads as working. One Pinchy can't open stays a checkbox with the
 * reason beside it: removing the grant is the wrong fix for a share mounted
 * with the wrong owner (#1363).
 */
export function DirectoryPicker({
  directories,
  selected,
  onChange,
  label,
  browseSubfolders = true,
  loadChildren = fetchChildren,
  grantedFolders,
}: DirectoryPickerProps) {
  const idPrefix = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, ChildState>>(() => new Map());
  const requested = useRef(new Set<string>());
  // Grants whose parents were already opened for the admin. Once is enough:
  // re-opening on every change would undo a folder the admin just closed.
  const revealed = useRef(new Set<string>());

  const selectedKeys = useMemo(() => new Set(selected.map(key)), [selected]);
  const statusByKey = useMemo(
    () => new Map((grantedFolders ?? []).map((folder) => [key(folder.path), folder.status])),
    [grantedFolders]
  );

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
      <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <FolderOpen className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          No directories are available yet. They show up here once they&apos;re mounted under{" "}
          <code>/data/</code>.{" "}
          <DocsLink path="guides/mount-data-directories" className="font-medium underline">
            How to mount data directories
          </DocsLink>
        </p>
      </div>
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

  // Counted by directory, not by stored spelling: a trailing-slash grant is
  // one. Subfolder grants are counted apart — "1 of 3" must not read as the
  // whole story when an agent also reads two folders inside another mount.
  const mountKeys = directories.map((dir) => key(dir.path));
  const selectedMounts = mountKeys.filter((k) => selectedKeys.has(k)).length;
  const selectedSubfolders = [...selectedKeys].filter((k) =>
    mountKeys.some((mount) => isInside(k, mount))
  ).length;

  // Rows are indented by depth; the chevron column keeps names aligned.
  const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 1.5}rem` });

  function renderFolder(dir: Directory, depth: number, index: string) {
    const k = key(dir.path);
    const isOpen = expanded.has(k);
    const cover = coveringGrant(dir.path);
    const checked = cover !== undefined || selectedKeys.has(k);
    const state = children.get(k);
    const checkboxId = `${idPrefix}-dir-${index}`;
    const pathId = `${checkboxId}-path`;
    const coverId = `${checkboxId}-cover`;
    const noteId = `${checkboxId}-note`;
    const note = selectedKeys.has(k) ? STATUS_NOTE[statusByKey.get(k) ?? "available"] : undefined;
    const describedBy = [pathId, cover && coverId, note && noteId].filter(Boolean).join(" ");

    return (
      <div key={k}>
        <div className="flex items-center" style={indent(depth)}>
          {/* Beside the label, never inside it: a click on the chevron must
              open the folder, not tick it. */}
          {browseSubfolders && (
            <button
              type="button"
              className="-ml-1 mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={`${isOpen ? "Hide" : "Show"} subfolders of ${dir.name}`}
              aria-expanded={isOpen}
              onClick={() => toggleExpanded(dir.path)}
            >
              <ChevronRight
                className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
          {/* The whole row is the hit target, not just the 16px box. */}
          <label
            htmlFor={checkboxId}
            className={`flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 transition-colors hover:bg-muted/50 has-[:focus-visible]:bg-muted/50 ${cover ? "" : "cursor-pointer"}`}
          >
            <Checkbox
              id={checkboxId}
              checked={checked}
              disabled={cover !== undefined}
              onCheckedChange={() => toggle(dir.path)}
              aria-label={dir.name}
              aria-describedby={describedBy}
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
              {cover && (
                <span id={coverId} className="block text-xs text-muted-foreground">
                  Included with {key(cover).split("/").pop()}
                </span>
              )}
              {note && (
                <span id={noteId} className="block text-xs text-destructive">
                  {note}
                </span>
              )}
            </span>
          </label>
        </div>
        {isOpen && (
          <div aria-live="polite" style={indent(depth + 1)} className="pl-7">
            {(!state || state.status === "loading") && (
              <p className="pb-2 text-xs text-muted-foreground">Loading…</p>
            )}
            {state?.status === "error" && (
              <p className="pb-2 text-xs text-destructive">
                Couldn&apos;t load the subfolders. Close and open the folder to try again.
              </p>
            )}
            {state?.status === "loaded" && state.directories.length === 0 && (
              <p className="pb-2 text-xs text-muted-foreground">No subfolders</p>
            )}
          </div>
        )}
        {isOpen && state?.status === "loaded" && state.directories.length > 0 && (
          <>
            {state.directories.map((child, childIndex) =>
              renderFolder(child, depth + 1, `${index}-${childIndex}`)
            )}
            {state.truncated && (
              <p className="pb-2 pl-7 text-xs text-muted-foreground" style={indent(depth + 1)}>
                Showing only the first {state.directories.length} subfolders.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="divide-y overflow-hidden rounded-lg border">
        {directories.map((dir, index) => renderFolder(dir, 0, String(index)))}
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedMounts} of {directories.length} selected
        {selectedSubfolders > 0 &&
          `, plus ${selectedSubfolders} ${selectedSubfolders === 1 ? "subfolder" : "subfolders"}`}
      </p>
      {missing.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {browseSubfolders
              ? "Also granted, but not shown in the folders above:"
              : "Also granted:"}
          </p>
          <div className="divide-y overflow-hidden rounded-lg border">
            {missing.map((grant, index) => {
              const grantKey = key(grant);
              const checkboxId = `${idPrefix}-missing-${index}`;
              const noteId = `${checkboxId}-note`;
              const status = statusByKey.get(grantKey);
              const note = STATUS_NOTE[status ?? "available"];
              if (status === "missing") {
                return (
                  <div key={grantKey} className="flex items-center gap-3 px-3 py-2.5">
                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-sm">{grantKey}</span>
                      <span id={noteId} className="block text-xs text-destructive">
                        {note}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${grantKey}`}
                      aria-describedby={noteId}
                      onClick={() => toggle(grant)}
                    >
                      Remove
                    </Button>
                  </div>
                );
              }
              return (
                <label
                  key={grantKey}
                  htmlFor={checkboxId}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50 has-[:focus-visible]:bg-muted/50"
                >
                  <Checkbox
                    id={checkboxId}
                    checked
                    onCheckedChange={() => toggle(grant)}
                    aria-label={grantKey}
                    aria-describedby={note ? noteId : undefined}
                  />
                  <Folder className="size-4 shrink-0 text-foreground" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block break-all text-sm">{grantKey}</span>
                    {note && (
                      <span id={noteId} className="block text-xs text-destructive">
                        {note}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
