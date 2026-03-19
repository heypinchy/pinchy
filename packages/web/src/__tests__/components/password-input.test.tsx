import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useForm } from "react-hook-form";
import { Form, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { PasswordInput } from "@/components/password-input";

/**
 * Wrapper that provides the react-hook-form + shadcn FormField context
 * required by PasswordInput (which uses useFormField internally).
 */
function TestWrapper({ label = "Password" }: { label?: string }) {
  const form = useForm({ defaultValues: { password: "" } });
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="password"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <PasswordInput {...field} />
          </FormItem>
        )}
      />
    </Form>
  );
}

describe("PasswordInput", () => {
  it("should render an input with type password by default", () => {
    render(<TestWrapper />);
    const input = screen.getByLabelText(/^password$/i);
    expect(input).toHaveAttribute("type", "password");
  });

  it("should render a toggle button", () => {
    render(<TestWrapper />);
    expect(screen.getByRole("button", { name: /show password/i })).toBeInTheDocument();
  });

  it("should toggle input type to text when clicking the toggle button", async () => {
    const user = userEvent.setup();
    render(<TestWrapper />);

    const input = screen.getByLabelText(/^password$/i);
    const toggle = screen.getByRole("button", { name: /show password/i });

    await user.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide password/i })).toBeInTheDocument();
  });

  it("should toggle back to password type on second click", async () => {
    const user = userEvent.setup();
    render(<TestWrapper />);

    const input = screen.getByLabelText(/^password$/i);
    const toggle = screen.getByRole("button", { name: /show password/i });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /show password/i })).toBeInTheDocument();
  });

  it("should not submit the form when toggle is clicked", () => {
    render(<TestWrapper />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle).toHaveAttribute("type", "button");
  });
});
