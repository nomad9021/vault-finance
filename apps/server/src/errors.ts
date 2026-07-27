import type { ErrorCode } from "@vault/shared";

/**
 * Domain error carrying a stable machine-readable code and HTTP status.
 * The global error handler maps these to the ApiError wire shape; anything
 * else becomes an opaque INTERNAL 500 so incidental Error messages never
 * leak implementation detail to clients.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const invalidCredentials = () =>
  new AppError("INVALID_CREDENTIALS", 401, "Email or password is incorrect.");

export const tokenExpired = () =>
  new AppError("TOKEN_EXPIRED", 401, "Access token has expired.");

export const tokenInvalid = () =>
  new AppError("TOKEN_INVALID", 401, "Access token is invalid.");

export const sessionRevoked = () =>
  new AppError("SESSION_REVOKED", 401, "This device session has been revoked.");

export const refreshTokenReused = () =>
  new AppError(
    "REFRESH_TOKEN_REUSED",
    401,
    "This refresh token was already used. The session has been revoked as a precaution — sign in again.",
  );

export const forbidden = (message = "You do not have permission to do that.") =>
  new AppError("FORBIDDEN", 403, message);

export const notFound = (what = "Resource") =>
  new AppError("NOT_FOUND", 404, `${what} not found.`);

export const rateLimited = () =>
  new AppError("RATE_LIMITED", 429, "Too many attempts. Try again shortly.");

export const totpRequired = () =>
  new AppError("TOTP_REQUIRED", 401, "This account has two-factor authentication. Enter your code.");

export const totpInvalid = () =>
  new AppError("TOTP_INVALID", 401, "That authentication code isn't valid. Try again.");
