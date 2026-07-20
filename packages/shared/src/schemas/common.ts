import { z } from "zod";

/** Stable machine-readable error codes — clients switch on these, never on message text. */
export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "INVALID_CREDENTIALS",
  "SESSION_REVOKED",
  "SESSION_NOT_FOUND",
  "TOKEN_EXPIRED",
  "TOKEN_INVALID",
  "REFRESH_TOKEN_REUSED",
  "SETUP_ALREADY_COMPLETE",
  "SETUP_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
  "CLIENT_VERSION_TOO_OLD",
  "CATEGORY_IN_USE",
  "AI_UNAVAILABLE",
  "AI_DISABLED",
  "BANK_DISABLED",
  "BANK_UNCONFIGURED",
  "BANK_UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    fields: z.record(z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Platform = z.enum(["windows", "macos", "linux", "ios"]);
export type Platform = z.infer<typeof Platform>;

export const UserRole = z.enum(["owner", "member"]);
export type UserRole = z.infer<typeof UserRole>;
