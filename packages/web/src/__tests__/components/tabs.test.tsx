import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

describe("TabsContent keepMounted", () => {
  it("should unmount inactive content by default", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
        <TabsContent value="b">Content B</TabsContent>
      </Tabs>
    );

    expect(screen.getByText("Content A")).toBeInTheDocument();
    expect(screen.queryByText("Content B")).not.toBeInTheDocument();
  });

  it("should keep inactive content mounted when keepMounted is true", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a" keepMounted>
          Content A
        </TabsContent>
        <TabsContent value="b" keepMounted>
          Content B
        </TabsContent>
      </Tabs>
    );

    // Both should be in DOM even though "b" is not the active tab
    expect(screen.getByText("Content A")).toBeInTheDocument();
    expect(screen.getByText("Content B")).toBeInTheDocument();
  });

  it("should hide inactive content visually when keepMounted is true", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a" keepMounted>
          Content A
        </TabsContent>
        <TabsContent value="b" keepMounted>
          Content B
        </TabsContent>
      </Tabs>
    );

    const contentB = screen.getByText("Content B").closest("[data-state]");
    expect(contentB).toHaveAttribute("data-state", "inactive");
  });
});
