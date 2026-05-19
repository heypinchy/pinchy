import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

/**
 * Regression test for issue #336.
 *
 * In the markdown editor (react-simple-code-editor + Prism), the visual
 * caret drifts away from the logical cursor when token-level styling
 * changes glyph metrics relative to the underlying <textarea>. The bug
 * has two known flavours, both caused by layout-affecting properties on
 * Prism token spans:
 *
 *   - Horizontal (per-token width inflation): `padding`/`margin`/etc. on
 *     inline-code spans makes the highlight <pre> wider than the
 *     <textarea> by ~1 char per span, so clicks land several columns off.
 *
 *   - Vertical (per-token line-box inflation): `font-size`/`font-weight`/
 *     `font-style` on headings/bold/italic tokens makes those lines taller
 *     in the <pre> than in the <textarea>. The offset accumulates over a
 *     long file with many such lines and lands clicks on a different line.
 *
 * This test exercises both at once: content with many headings interleaved
 * with normal lines (vertical accumulator), and a marker line whose ▲ sits
 * after several inline-code spans (horizontal accumulator). The marker's
 * <pre> rect captures both offsets, so a single click→selectionStart
 * comparison catches either flavour.
 */

test.describe("Markdown editor caret alignment", () => {
  test.beforeEach(async ({ page }) => {
    // Tall viewport — the editor expands to its intrinsic content height
    // and we need ~50 lines of content fully on-screen for the click test.
    await page.setViewportSize({ width: 1280, height: 1600 });
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("click position in long content with headings and inline-code spans matches the typed character", async ({
    page,
  }) => {
    const smithersLink = page.getByRole("link", { name: /smithers/i }).first();
    await smithersLink.waitFor({ timeout: 10000 });
    const href = await smithersLink.getAttribute("href");
    expect(href).toMatch(/\/chat\/[0-9a-f-]+/);
    const agentId = href!.match(/\/chat\/([0-9a-f-]+)/)![1];

    // Open the Instructions tab (AGENTS.md) — the exact URL from the bug
    // report.
    await page.goto(`/chat/${agentId}/settings?tab=instructions`);
    await page.waitForLoadState("networkidle");

    const editor = page.locator(".markdown-editor").first();
    await editor.waitFor({ timeout: 10000 });

    const textarea = editor.locator("textarea").first();
    await textarea.click();

    // Build a realistic AGENTS.md-style content:
    //   - 20 headings interleaved with paragraphs and short list items
    //     (vertical accumulator: each heading is 2px taller in the <pre>
    //     if the heading rule uses font-size: 1.1em, so 20 headings → 40px
    //     drift → 2 visual lines off);
    //   - the marker line near the end has five inline-code spans before
    //     the ▲ (horizontal accumulator: each span inflates the <pre>
    //     width if the inline-code rule uses padding, drifting the click
    //     position by ~1 char per span).
    const sections: string[] = [];
    for (let i = 1; i <= 20; i++) {
      sections.push(`## Section ${i}`);
      sections.push(`Paragraph text describing section ${i} briefly.`);
      sections.push(`- bullet point for section ${i}`);
    }
    sections.push("");
    sections.push("Marker line: `a`, `b`, `c`, `d`, `e`▲END");
    sections.push("- trailing line 1");
    sections.push("- trailing line 2");
    const CONTENT = sections.join("\n");

    // Set the textarea value via React's controlled-input pattern: use the
    // native value setter so React's input event listener picks up the
    // change, then dispatch a synthetic input event. Typing character by
    // character via page.keyboard.type would take 30+ seconds for this
    // payload on CI and trip the test timeout.
    await editor.evaluate((root, value) => {
      const ta = root.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      setter.call(ta, value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, CONTENT);

    await expect(editor.locator("pre .token.code-snippet").first()).toBeVisible();
    await expect(editor.locator("pre .token.title.important").first()).toBeVisible();

    // Find the rect of "▲" in the <pre> by walking text nodes.
    const target = await editor.evaluate((root) => {
      const pre = root.querySelector("pre") as HTMLElement;
      const ta = root.querySelector("textarea") as HTMLTextAreaElement;
      const markerIndex = ta.value.indexOf("▲");
      if (markerIndex < 0) return null;

      let charsSeen = 0;
      const findRect = (node: Node): DOMRect | null => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent ?? "";
          const localIdx = markerIndex - charsSeen;
          if (localIdx >= 0 && localIdx < t.length) {
            const range = document.createRange();
            range.setStart(node, localIdx);
            range.setEnd(node, localIdx + 1);
            return range.getBoundingClientRect();
          }
          charsSeen += t.length;
          return null;
        }
        for (const child of Array.from(node.childNodes)) {
          const r = findRect(child);
          if (r) return r;
        }
        return null;
      };
      const rect = findRect(pre);
      return rect
        ? {
            markerIndex,
            x: rect.left,
            y: (rect.top + rect.bottom) / 2,
          }
        : null;
    });
    expect(target, "could not locate '▲' in the highlight <pre>").not.toBeNull();

    // Click on the LEFT edge of the marker glyph in the <pre>. The
    // <textarea> must resolve that pixel to position `markerIndex`. On
    // main, both vertical (heading-induced) and horizontal (padding-
    // induced) drift land selectionStart on a different character.
    await page.mouse.click(target!.x, target!.y);

    const state = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const toLineCol = (pos: number) => {
        const before = ta.value.slice(0, pos);
        const line = (before.match(/\n/g) ?? []).length;
        const col = pos - (before.lastIndexOf("\n") + 1);
        return { line, col };
      };
      return {
        selectionStart: ta.selectionStart,
        actualLC: toLineCol(ta.selectionStart),
      };
    });

    const expectedLC = (() => {
      const before = CONTENT.slice(0, target!.markerIndex);
      const line = (before.match(/\n/g) ?? []).length;
      const col = target!.markerIndex - (before.lastIndexOf("\n") + 1);
      return { line, col };
    })();

    // ±1 char tolerance for sub-pixel rounding on the left/right side of
    // the glyph. Real drift on main is at least several characters and
    // often a whole line of vertical offset.
    const drift = Math.abs(state.selectionStart - target!.markerIndex);
    expect(
      drift,
      `caret drift: clicked <pre>'s '▲' at (line ${expectedLC.line}, col ${expectedLC.col}, index ${target!.markerIndex}); textarea selectionStart=${state.selectionStart} → (line ${state.actualLC.line}, col ${state.actualLC.col})`
    ).toBeLessThanOrEqual(1);
  });
});
