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

  it("should show empty state message when no directories available", () => {
    render(<DirectoryPicker directories={[]} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/mount directories/i)).toBeInTheDocument();
  });
});
