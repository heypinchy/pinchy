import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { AppleSplashLinks } from "@/components/apple-splash-links";
import { DEVICES } from "@/lib/pwa/devices";

// React 19's Document Metadata feature hoists `<link>` tags rendered anywhere
// in the tree into `document.head`. That's what we want in production (Next.js
// puts these into the document `<head>` for iOS to read on "Add to Home
// Screen"), so we assert against `document.head` here too.
function getSplashLinks() {
  return document.head.querySelectorAll('link[rel="apple-touch-startup-image"]');
}

// Testing Library auto-cleans the render container, but not links React 19
// hoisted into <head>. Clear them between tests so counts don't accumulate.
beforeEach(() => {
  for (const link of Array.from(getSplashLinks())) {
    link.remove();
  }
});

describe("<AppleSplashLinks />", () => {
  it("renders one link per device per orientation", () => {
    render(<AppleSplashLinks />);
    const links = getSplashLinks();
    expect(links.length).toBe(DEVICES.length * 2);
  });

  it("each link has a media query and an href under /splash/", () => {
    render(<AppleSplashLinks />);
    const links = Array.from(getSplashLinks());
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/splash\/.+\.png$/);
      const media = link.getAttribute("media");
      expect(media).toMatch(/device-width/);
      expect(media).toMatch(/device-height/);
      expect(media).toMatch(/-webkit-device-pixel-ratio/);
      expect(media).toMatch(/orientation:\s*(portrait|landscape)/);
    }
  });

  it("media query uses logical CSS pixels, not physical", () => {
    render(<AppleSplashLinks />);
    const firstDevice = DEVICES[0];
    const portraitLink = document.head.querySelector<HTMLLinkElement>(
      `link[href="/splash/${firstDevice.slug}-portrait.png"]`
    );
    expect(portraitLink).not.toBeNull();
    const media = portraitLink!.getAttribute("media")!;
    expect(media).toContain(`device-width: ${firstDevice.logicalWidth}px`);
    expect(media).toContain(`device-height: ${firstDevice.logicalHeight}px`);
    expect(media).toContain(`-webkit-device-pixel-ratio: ${firstDevice.pixelRatio}`);
  });
});
