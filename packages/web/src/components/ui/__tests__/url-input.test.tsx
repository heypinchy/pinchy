import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UrlInput } from "../url-input";

describe("UrlInput", () => {
  it("normalizes value onBlur (prepends https:// for bare hostname)", async () => {
    const handleChange = vi.fn();
    render(<UrlInput value="odoo-demo.heypinchy.com" onChange={handleChange} />);

    const input = screen.getByRole("textbox");
    input.focus();
    await userEvent.tab(); // blur

    // The synthetic change event should fire with the normalized value
    expect(handleChange).toHaveBeenCalled();
    const lastCall = handleChange.mock.calls.at(-1);
    const event = lastCall?.[0];
    expect(event.target.value).toBe("https://odoo-demo.heypinchy.com");
  });

  it("normalizes value onBlur (strips path)", async () => {
    const handleChange = vi.fn();
    render(<UrlInput value="https://odoo.example.com/web/login" onChange={handleChange} />);

    const input = screen.getByRole("textbox");
    input.focus();
    await userEvent.tab();

    const event = handleChange.mock.calls.at(-1)?.[0];
    expect(event.target.value).toBe("https://odoo.example.com");
  });

  it("does not fire onChange when value is already normalized", async () => {
    const handleChange = vi.fn();
    render(<UrlInput value="https://odoo.example.com" onChange={handleChange} />);

    const input = screen.getByRole("textbox");
    input.focus();
    await userEvent.tab();

    expect(handleChange).not.toHaveBeenCalled();
  });

  it("leaves invalid input untouched (zod validation will catch it later)", async () => {
    const handleChange = vi.fn();
    render(<UrlInput value="not a url" onChange={handleChange} />);

    const input = screen.getByRole("textbox");
    input.focus();
    await userEvent.tab();

    expect(handleChange).not.toHaveBeenCalled();
  });

  it("still forwards onBlur callback when provided", async () => {
    const handleBlur = vi.fn();
    render(<UrlInput value="https://example.com" onBlur={handleBlur} onChange={() => {}} />);

    screen.getByRole("textbox").focus();
    await userEvent.tab();

    expect(handleBlur).toHaveBeenCalled();
  });

  it("renders as a plain text input (not type=url) so submission isn't blocked by missing protocol", () => {
    render(<UrlInput value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("url");
  });
});
