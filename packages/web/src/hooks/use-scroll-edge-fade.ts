"use client";

import { useEffect, useState, type CSSProperties } from "react";

const FADE = "2rem";

type ScrollBox = Pick<HTMLElement, "scrollLeft" | "clientWidth" | "scrollWidth">;

/**
 * A mask that fades each horizontal edge with content beyond it, or undefined
 * when the content fits. A row with a hidden scrollbar otherwise gives no hint
 * that more items sit off-screen (#1400).
 */
export function edgeFadeMask({ scrollLeft, clientWidth, scrollWidth }: ScrollBox) {
  // One pixel of slack: zoomed and high-DPI browsers report fractional positions.
  const left = scrollLeft > 1;
  const right = scrollLeft + clientWidth < scrollWidth - 1;
  if (!left && !right) return undefined;
  const start = left ? `transparent, black ${FADE}` : "black 0";
  const end = right ? `black calc(100% - ${FADE}), transparent` : "black 100%";
  return `linear-gradient(to right, ${start}, ${end})`;
}

/**
 * Tracks a horizontally scrolling element and returns the style that fades its
 * overflowing edges. `ref` is a callback ref, so an element that mounts later
 * (after a loading state) is picked up too; `element` exposes it to callers.
 */
export function useScrollEdgeFade<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [mask, setMask] = useState<string | undefined>();

  useEffect(() => {
    if (!element) return;
    const update = () => setMask(edgeFadeMask(element));
    update();
    element.addEventListener("scroll", update, { passive: true });
    // The children too: a list clamped to its parent keeps its own size while
    // its content grows (e.g. a tab gaining an unsaved-changes dot).
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [element]);

  const style: CSSProperties | undefined = mask
    ? { maskImage: mask, WebkitMaskImage: mask }
    : undefined;
  return { ref: setElement, element, style };
}
