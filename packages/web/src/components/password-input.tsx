"use client";

import * as React from "react";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useFormField } from "@/components/ui/form";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  ref?: React.Ref<HTMLInputElement>;
};

/**
 * Password input with show/hide toggle, designed to work inside shadcn/ui FormField.
 *
 * Usage (inside a FormField render prop):
 *   <FormItem>
 *     <FormLabel>Password</FormLabel>
 *     <PasswordInput {...field} />
 *     <FormMessage />
 *   </FormItem>
 *
 * Note: Do NOT wrap in <FormControl> — PasswordInput wires up
 * the form field id and aria attributes internally via useFormField().
 */
function PasswordInput({ className, ref, ...props }: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);
  const { formItemId, formDescriptionId, formMessageId, error } = useFormField();

  return (
    <div className="relative">
      <Input
        type={showPassword ? "text" : "password"}
        className={cn("pr-10", className)}
        ref={ref}
        id={formItemId}
        aria-describedby={!error ? formDescriptionId : `${formDescriptionId} ${formMessageId}`}
        aria-invalid={!!error}
        {...props}
      />
      <button
        type="button"
        className="absolute right-0 top-0 h-full px-3 py-2 text-muted-foreground hover:text-foreground"
        onClick={() => setShowPassword((prev) => !prev)}
        aria-label={showPassword ? "Hide password" : "Show password"}
      >
        {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export { PasswordInput };
