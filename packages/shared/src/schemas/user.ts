import { z } from "zod";
import { NewPassword } from "./password.js";
import { UserRole } from "./common.js";

/**
 * A profile picture: a JPEG, PNG or WebP data: URL. The app crops and shrinks
 * it to 256×256 first, so the limit is generous for that and no more.
 */
export const AvatarImage = z
  .string()
  .max(300_000, "That picture is too large — pick a smaller one.")
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, "Use a JPEG, PNG or WebP picture.");

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  avatarImage: AvatarImage.nullish(),
  role: UserRole,
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const UpdateMeRequest = z
  .object({
    displayName: z.string().min(1).max(100),
    avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    /** A new picture, or null to remove it. */
    avatarImage: AvatarImage.nullable(),
    currentPassword: z.string().min(1),
    newPassword: NewPassword,
  })
  .partial()
  .refine((v) => !v.newPassword || v.currentPassword, {
    message: "currentPassword is required to set a new password",
    path: ["currentPassword"],
  });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

/** One dashboard card or section: where it goes, whether it shows, how wide (of 12 columns). */
export const DashboardWidget = z.object({
  id: z.string().min(1).max(40),
  hidden: z.boolean().default(false),
  span: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).optional(),
});
export type DashboardWidget = z.infer<typeof DashboardWidget>;

/** Preferences stored on the server so they follow the person to every device. */
export const UserPreferences = z.object({
  /** Dashboard widgets in order; unknown ids are ignored, missing ones appended. */
  dashboard: z.array(DashboardWidget).max(60).optional(),
});
export type UserPreferences = z.infer<typeof UserPreferences>;
