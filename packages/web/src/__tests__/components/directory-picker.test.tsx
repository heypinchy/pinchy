// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DirectoryPicker } from "@/components/directory-picker";

describe("DirectoryPicker", () => {
  const directories = [
    { path: "/data/documents", name: "documents" },
    { path: "/data/hr-docs", name: "hr-docs" },
    { path: "/data/support", name: "support" },
  ];

  it("should render all directories with checkboxes", () => {
    render(<DirectoryPicker directories={directories} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText("documents")).toBeInTheDocument();
    expect(screen.getByText("hr-docs")).toBeInTheDocument();
    expect(screen.getByText("support")).toBeInTheDocument();
  });

  it("should check selected directories", () => {
    render(
      <DirectoryPicker directories={directories} selected={["/data/hr-docs"]} onChange={vi.fn()} />
    );
    const checkbox = screen.getByRole("checkbox", { name: /hr-docs/i });
    expect(checkbox).toBeChecked();
  });

  it("should call onChange when a directory is toggled", () => {
    const onChange = vi.fn();
    render(<DirectoryPicker directories={directories} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /documents/i }));
    expect(onChange).toHaveBeenCalledWith(["/data/documents"]);
  });

  // A stored grant may carry a trailing slash (written through the API or by an
  // older version), while /api/data-directories lists mounts without one. A grant must still
  // read as checked, and unticking it must remove the stored entry (#1264).
  it("checks a directory whose grant is stored with a trailing slash", () => {
    render(
      <DirectoryPicker directories={directories} selected={["/data/hr-docs/"]} onChange={vi.fn()} />
    );
    expect(screen.getByRole("checkbox", { name: /hr-docs/i })).toBeChecked();
  });

  it("unticking a trailing-slash grant removes it instead of adding a second entry", () => {
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={directories}
        selected={["/data/hr-docs/"]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /hr-docs/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("unticking removes every spelling of the same directory", () => {
    // A selection already polluted by the old exact-match toggle holds both.
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={directories}
        selected={["/data/hr-docs/", "/data/hr-docs", "/data/support/"]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /hr-docs/i }));
    expect(onChange).toHaveBeenCalledWith(["/data/support/"]);
  });

  // The name is what an admin recognises; the mount path is what tells two
  // same-named shares apart. Name as the label, path as the description, so a
  // screen reader hears both without the path drowning the name (#1305).
  it("names each checkbox after the folder and describes it with its path", () => {
    render(<DirectoryPicker directories={directories} selected={[]} onChange={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: "hr-docs" });
    expect(checkbox).toHaveAccessibleDescription("/data/hr-docs");
  });

  it("groups the folders under an accessible name and says how many are selected", () => {
    render(
      <DirectoryPicker
        directories={directories}
        selected={["/data/hr-docs/"]}
        onChange={vi.fn()}
        label="Allowed Directories"
      />
    );
    expect(screen.getByRole("group", { name: "Allowed Directories" })).toBeInTheDocument();
    // Counted by directory, not by stored spelling: a trailing-slash grant is one.
    expect(screen.getByText("1 of 3 selected")).toBeInTheDocument();
  });

  // The whole row is the hit target; clicking the name must toggle exactly
  // once (a label around a Radix checkbox button could otherwise double-fire).
  it("toggles once when the folder's name is clicked", () => {
    const onChange = vi.fn();
    render(<DirectoryPicker directories={directories} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText("support"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["/data/support"]);
  });

  it("should show empty state message when no directories available", () => {
    render(<DirectoryPicker directories={[]} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/mounted under/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /how to mount data directories/i })
    ).toBeInTheDocument();
  });
});

describe("DirectoryPicker — subfolders (#1269)", () => {
  const mounts = [
    { path: "/data/suppliers", name: "suppliers" },
    { path: "/data/hr", name: "hr" },
  ];

  const tree: Record<string, Array<{ path: string; name: string }>> = {
    "/data/suppliers": [
      { path: "/data/suppliers/food", name: "food" },
      { path: "/data/suppliers/vet", name: "vet" },
    ],
    "/data/suppliers/food": [{ path: "/data/suppliers/food/2026", name: "2026" }],
    "/data/suppliers/vet": [],
    "/data/hr": [],
  };

  function loader() {
    return vi.fn(async (path: string) => ({
      directories: tree[path.replace(/\/+$/, "")] ?? [],
      truncated: false,
    }));
  }

  it("expands a mount on demand and grants a subfolder", async () => {
    const loadChildren = loader();
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={mounts}
        selected={[]}
        onChange={onChange}
        loadChildren={loadChildren}
      />
    );

    // Lazy: nothing is listed until the admin opens a folder.
    expect(loadChildren).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of suppliers" }));
    expect(loadChildren).toHaveBeenCalledWith("/data/suppliers");
    fireEvent.click(await screen.findByRole("checkbox", { name: "food" }));

    expect(onChange).toHaveBeenCalledWith(["/data/suppliers/food"]);
  });

  it("shows a granted subfolder ticked without the admin having to open its parents", async () => {
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={mounts}
        // The shape sanitizePath stores: trailing slash.
        selected={["/data/suppliers/food/2026/"]}
        onChange={onChange}
        loadChildren={loader()}
      />
    );

    const checkbox = await screen.findByRole("checkbox", { name: "2026" });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows the subfolders of a granted folder as included, not separately grantable", async () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers/"]}
        onChange={vi.fn()}
        loadChildren={loader()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of suppliers" }));
    const food = await screen.findByRole("checkbox", { name: "food" });
    expect(food).toBeChecked();
    expect(food).toBeDisabled();
    expect(screen.getAllByText(/included with suppliers/i).length).toBeGreaterThan(0);
  });

  it("granting a parent folds in the subfolders already granted below it", async () => {
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers/food/", "/data/hr/"]}
        onChange={onChange}
        loadChildren={loader()}
      />
    );

    await screen.findByRole("checkbox", { name: "food" });
    fireEvent.click(screen.getByRole("checkbox", { name: "suppliers" }));

    expect(onChange).toHaveBeenCalledWith(["/data/hr/", "/data/suppliers"]);
  });

  it("does not treat a sibling with a shared prefix as a subfolder", async () => {
    render(
      <DirectoryPicker
        directories={[...mounts, { path: "/data/suppliers-archive", name: "suppliers-archive" }]}
        selected={["/data/suppliers"]}
        onChange={vi.fn()}
        loadChildren={loader()}
      />
    );

    const archive = screen.getByRole("checkbox", { name: "suppliers-archive" });
    expect(archive).not.toBeChecked();
    expect(archive).toBeEnabled();
  });

  it("says so when a folder has no subfolders", async () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={[]}
        onChange={vi.fn()}
        loadChildren={loader()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of hr" }));
    expect(await screen.findByText("No subfolders")).toBeInTheDocument();
  });

  it("says so when the subfolders cannot be loaded", async () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={[]}
        onChange={vi.fn()}
        loadChildren={vi.fn().mockRejectedValue(new Error("boom"))}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of hr" }));
    expect(await screen.findByText(/couldn't load the subfolders/i)).toBeInTheDocument();
  });

  it("says so when a folder holds more subfolders than are shown", async () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={[]}
        onChange={vi.fn()}
        loadChildren={vi.fn().mockResolvedValue({
          directories: [{ path: "/data/hr/a", name: "a" }],
          truncated: true,
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of hr" }));
    expect(await screen.findByText(/only the first/i)).toBeInTheDocument();
  });

  it("collapses an open folder again", async () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={[]}
        onChange={vi.fn()}
        loadChildren={loader()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show subfolders of suppliers" }));
    await screen.findByRole("checkbox", { name: "food" });
    fireEvent.click(screen.getByRole("button", { name: "Hide subfolders of suppliers" }));
    expect(screen.queryByRole("checkbox", { name: "food" })).not.toBeInTheDocument();
  });

  it("keeps a grant the picker cannot find visible, so it can still be revoked", async () => {
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/old-share/", "/data/suppliers/gone/"]}
        onChange={onChange}
        loadChildren={loader()}
      />
    );

    const oldShare = await screen.findByRole("checkbox", { name: "/data/old-share" });
    const gone = await screen.findByRole("checkbox", { name: "/data/suppliers/gone" });
    expect(oldShare).toBeChecked();
    expect(gone).toBeChecked();

    fireEvent.click(oldShare);
    expect(onChange).toHaveBeenCalledWith(["/data/suppliers/gone/"]);
  });
});

describe("DirectoryPicker — opening granted folders", () => {
  it("does not reopen a folder the admin closed when the selection changes", async () => {
    const mounts = [
      { path: "/data/suppliers", name: "suppliers" },
      { path: "/data/hr", name: "hr" },
    ];
    const loadChildren = vi.fn(async (path: string) => ({
      directories:
        path === "/data/suppliers" ? [{ path: "/data/suppliers/food", name: "food" }] : [],
      truncated: false,
    }));
    const { rerender } = render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers/food/"]}
        onChange={vi.fn()}
        loadChildren={loadChildren}
      />
    );
    await screen.findByRole("checkbox", { name: "food" });
    fireEvent.click(screen.getByRole("button", { name: "Hide subfolders of suppliers" }));

    rerender(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers/food/", "/data/hr"]}
        onChange={vi.fn()}
        loadChildren={loadChildren}
      />
    );

    expect(screen.queryByRole("checkbox", { name: "food" })).not.toBeInTheDocument();
  });
});

describe("DirectoryPicker — without subfolder browsing", () => {
  it("offers no chevrons, loads nothing, and still lists subfolder grants so they can be seen", async () => {
    const loadChildren = vi.fn();
    render(
      <DirectoryPicker
        directories={[{ path: "/data/suppliers", name: "suppliers" }]}
        selected={["/data/suppliers/food/"]}
        onChange={vi.fn()}
        browseSubfolders={false}
        loadChildren={loadChildren}
      />
    );

    expect(screen.queryByRole("button", { name: /subfolders of/i })).not.toBeInTheDocument();
    expect(loadChildren).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "/data/suppliers/food" })).toBeChecked();
  });
});

describe("DirectoryPicker — grants below a folder the tree cannot reach", () => {
  it("lists a deep grant whose ancestor is cut from a truncated listing, so it can be revoked", async () => {
    const onChange = vi.fn();
    const loadChildren = vi.fn(async (path: string) => {
      if (path === "/data/suppliers") {
        // `zfolder` sorts beyond the 500-folder cut.
        return { directories: [{ path: "/data/suppliers/a", name: "a" }], truncated: true };
      }
      if (path === "/data/suppliers/zfolder") {
        return {
          directories: [{ path: "/data/suppliers/zfolder/2026", name: "2026" }],
          truncated: false,
        };
      }
      return { directories: [], truncated: false };
    });
    render(
      <DirectoryPicker
        directories={[{ path: "/data/suppliers", name: "suppliers" }]}
        selected={["/data/suppliers/zfolder/2026/"]}
        onChange={onChange}
        loadChildren={loadChildren}
      />
    );

    const grant = await screen.findByRole("checkbox", { name: "/data/suppliers/zfolder/2026" });
    expect(grant).toBeChecked();
    fireEvent.click(grant);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe("DirectoryPicker — selection count with subfolders", () => {
  it("counts subfolder grants apart from the mounts", () => {
    render(
      <DirectoryPicker
        directories={[
          { path: "/data/suppliers", name: "suppliers" },
          { path: "/data/hr", name: "hr" },
        ]}
        selected={["/data/hr/", "/data/suppliers/food/", "/data/suppliers/vet"]}
        onChange={vi.fn()}
        browseSubfolders={false}
      />
    );
    expect(screen.getByText("1 of 2 selected, plus 2 subfolders")).toBeInTheDocument();
  });
});

// A grant outlives the folder it names: rename a mount and the agent keeps a
// grant for the old path, which used to sit in the list as an ordinary ticked
// box (#1363). The settings page asks the server which grants still exist and
// hands the answer in; the picker says so where the grant is shown.
describe("DirectoryPicker — grants whose folder is gone or can't be opened (#1363)", () => {
  const mounts = [{ path: "/data/suppliers", name: "suppliers" }];

  it("marks a grant whose folder is gone and offers to remove it", async () => {
    const onChange = vi.fn();
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers", "/data/pinchy-suppliers/"]}
        onChange={onChange}
        browseSubfolders={false}
        grantedFolders={[
          { path: "/data/suppliers", status: "available" },
          { path: "/data/pinchy-suppliers/", status: "missing" },
        ]}
      />
    );

    // The one action is removing it — not a ticked box that reads as working.
    expect(screen.queryByRole("checkbox", { name: "/data/pinchy-suppliers" })).toBeNull();
    expect(screen.getByText("/data/pinchy-suppliers")).toBeInTheDocument();
    expect(screen.getByText(/Folder not found/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove /data/pinchy-suppliers" }));
    expect(onChange).toHaveBeenCalledWith(["/data/suppliers"]);
  });

  it("tells a folder Pinchy can't open apart from one that is gone, and keeps it granted", () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/suppliers", "/data/locked/"]}
        onChange={vi.fn()}
        browseSubfolders={false}
        grantedFolders={[
          { path: "/data/suppliers", status: "unreadable" },
          { path: "/data/locked/", status: "unreadable" },
        ]}
      />
    );

    // Removing the grant is the wrong fix for a share mounted with the wrong
    // owner, so it stays an ordinary checkbox — with the reason beside it,
    // in the tree as well as in the list below it.
    expect(screen.getByRole("checkbox", { name: "suppliers" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "/data/locked" })).toBeChecked();
    expect(screen.getAllByText(/Pinchy can't open this folder/)).toHaveLength(2);
    expect(screen.queryByText(/Folder not found/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "suppliers" })).toHaveAccessibleDescription(
      /Pinchy can't open this folder/
    );
  });

  it("says when a grant runs through a link agents can't read through", () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/shortcut"]}
        onChange={vi.fn()}
        browseSubfolders={false}
        grantedFolders={[{ path: "/data/shortcut", status: "link" }]}
      />
    );
    expect(screen.getByRole("checkbox", { name: "/data/shortcut" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "/data/shortcut" })).toHaveAccessibleDescription(
      /symbolic link/
    );
  });

  it("shows grants as before when no status is known", () => {
    render(
      <DirectoryPicker
        directories={mounts}
        selected={["/data/pinchy-suppliers"]}
        onChange={vi.fn()}
        browseSubfolders={false}
      />
    );
    expect(screen.getByRole("checkbox", { name: "/data/pinchy-suppliers" })).toBeChecked();
    expect(screen.queryByText(/Folder not found/)).toBeNull();
  });
});
