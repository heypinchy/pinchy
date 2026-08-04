"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm, useFormState } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/validate-password";
import { apiPost, apiPatch, errorMessage } from "@/lib/api-client";
import type { UpdateMeInput, ChangePasswordInput } from "@/lib/schemas/settings";

const nameSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

// The FORM's shape, not the route's: `confirmPassword` never leaves the
// browser. The payload is typed by ChangePasswordInput at the call site.
const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type NameFormValues = z.infer<typeof nameSchema>;
type PasswordFormValues = z.infer<typeof passwordFormSchema>;

interface SettingsProfileProps {
  userName: string;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function SettingsProfile({ userName, onDirtyChange }: SettingsProfileProps) {
  const router = useRouter();

  const nameForm = useForm<NameFormValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: userName },
  });

  // Sync form when userName prop arrives asynchronously (session loading)
  useEffect(() => {
    if (userName) {
      nameForm.reset({ name: userName });
    }
  }, [userName, nameForm]);

  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const { isDirty: isNameDirty } = useFormState({ control: nameForm.control });
  const { isDirty: isPasswordDirty } = useFormState({ control: passwordForm.control });

  useEffect(() => {
    onDirtyChange?.(isNameDirty || isPasswordDirty);
  }, [isNameDirty, isPasswordDirty, onDirtyChange]);

  async function onNameSubmit(values: NameFormValues) {
    try {
      await apiPatch<unknown, UpdateMeInput>("/api/users/me", { name: values.name });
      toast.success("Name updated");
      nameForm.reset({ name: values.name });
    } catch (e) {
      nameForm.setError("root", {
        message: errorMessage(e, "Failed to update name"),
      });
    }
  }

  async function onPasswordSubmit(values: PasswordFormValues) {
    try {
      await apiPost<unknown, ChangePasswordInput>("/api/users/me/password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      // Say what actually happened: the change revokes every session this
      // user holds (revokeOtherSessions in the route), so their phone and
      // second machine are signed out. This tab keeps working — the route
      // forwards the reissued session cookie — which is exactly why the
      // sign-out would otherwise go unnoticed until someone else's device
      // asked for a password.
      toast.success("Password updated. Your other devices have been signed out.");
      passwordForm.reset();
    } catch (e) {
      passwordForm.setError("root", {
        message: errorMessage(e, "Failed to change password"),
      });
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...nameForm}>
            <form
              onSubmit={nameForm.handleSubmit(onNameSubmit)}
              method="post"
              className="space-y-6"
            >
              <FormField
                control={nameForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Your name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {nameForm.formState.errors.root && (
                <p className="text-sm text-destructive">{nameForm.formState.errors.root.message}</p>
              )}
              <Button type="submit" disabled={nameForm.formState.isSubmitting}>
                Save
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...passwordForm}>
            <form
              onSubmit={passwordForm.handleSubmit(onPasswordSubmit)}
              method="post"
              className="space-y-6"
            >
              <FormField
                control={passwordForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {passwordForm.formState.errors.root && (
                <p className="text-sm text-destructive">
                  {passwordForm.formState.errors.root.message}
                </p>
              )}
              <Button type="submit" disabled={passwordForm.formState.isSubmitting}>
                Change Password
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={async () => {
              await authClient.signOut();
              router.push("/login");
            }}
          >
            Log out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
