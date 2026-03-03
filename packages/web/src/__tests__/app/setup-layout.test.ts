import { describe, it, expect } from "vitest";
import React from "react";
import SetupLayout from "@/app/setup/layout";

describe("Setup Layout", () => {
  it("should render children without redirect", () => {
    const mockChildren = React.createElement("div", null, "Setup Form");
    const result = SetupLayout({ children: mockChildren });
    expect(result).toBeTruthy();
  });

  it("should return children unchanged", () => {
    const mockChildren = React.createElement("div", { "data-testid": "child" }, "content");
    const result = SetupLayout({ children: mockChildren });
    expect(result).toBe(mockChildren);
  });
});
