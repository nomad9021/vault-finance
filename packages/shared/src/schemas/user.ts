import { z } from "zod";
import { UserRole } from "./common.js";

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: UserRole,
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const UpdateMeRequest = z
  .object({
    displayName: z.string().min(1).max(100),
    avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10).max(200),
  })
  .partial()
  .refine((v) => !v.newPassword || v.currentPassword, {
    message: "currentPassword is required to set a new password",
    path: ["currentPassword"],
  });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;
