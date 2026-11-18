import { describe, it, expect } from "vitest";
import { budgetPercent, formatUsd } from "@/lib/budget-format";

describe("formatUsd", () => {
  it("formats dollars with cents, the way the budget card and banner both show them", () => {
    expect(formatUsd(84.1)).toBe("$84.10");
    expect(formatUsd(1234)).toBe("$1,234.00");
  });
});

describe("budgetPercent", () => {
  it("rounds down, so 79.9% never reads as the 80% warning line", () => {
    expect(budgetPercent(79.9, 100)).toBe(79);
    expect(budgetPercent(101, 100)).toBe(101);
  });
});
