import plugin from "./index.js";

it("exports a plugin manifest", () => {
  expect(plugin.name).toBe("pinchy-mcp");
});
