import { describe, it, expect, vi } from "vitest";

// The root layout pulls in next/font (an SWC-time transform that has no
// runtime in vitest) and the global stylesheet. Neither matters for the
// viewport export under test.
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

describe("root layout viewport", () => {
  it("lets the virtual keyboard resize the layout viewport (#955)", async () => {
    const { viewport } = await import("@/app/layout");

    // Without this, the browser default `resizes-visual` applies: the on-screen
    // keyboard shrinks only the VISUAL viewport, so a `h-dvh` chat column keeps
    // its full height and the composer stays underneath the keyboard — reaching
    // it means scrolling the whole page, which drags the chat header off screen.
    // `resizes-content` shrinks the LAYOUT viewport instead, so the existing
    // flex column reflows on its own: header pinned, composer above the keyboard.
    expect(viewport.interactiveWidget).toBe("resizes-content");
  });

  it("keeps the existing viewport settings", async () => {
    const { viewport } = await import("@/app/layout");

    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
    expect(viewport.viewportFit).toBe("cover");
  });
});
