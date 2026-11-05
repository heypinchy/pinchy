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

  it("should show empty state message when no directories available", () => {
    render(<DirectoryPicker directories={[]} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/mount directories/i)).toBeInTheDocument();
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
