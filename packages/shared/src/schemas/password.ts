import { z } from "zod";

/**
 * Rules for every NEW password (setup, change, member, invite). Existing
 * passwords keep working; these apply the next time one is set.
 *
 * Length does most of the work (NIST SP 800-63B): 12+ characters, plus a
 * refusal of passwords that are long but trivially guessable.
 */
export const MIN_PASSWORD_LENGTH = 12;

const COMMON = new Set([
  "password1234", "password12345", "password123456", "passwordpassword", "123456789012",
  "1234567890123", "12345678901234", "qwertyuiop12", "qwertyuiop123", "qwertyuiopasdf",
  "iloveyou1234", "abcdefghijkl", "abcdefgh1234", "abc123abc123", "letmein12345",
  "welcome12345", "changeme1234", "administrator", "trustno1trustno1", "monkey123456",
  "football1234", "baseball1234", "superman1234", "princess1234", "sunshine1234",
  "password!234", "p@ssword1234", "p@ssw0rd1234", "passw0rd1234", "vaultfinance",
  "vaultfinance1", "vaultfinance123", "correcthorsebatterystaple",
]);

/** Why `pw` is too weak, or null when it's fine. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  const folded = pw.toLowerCase().replace(/[\s_-]/g, "");
  if (COMMON.has(folded)) return "That password is too common. A few random words work well.";
  if (new Set(pw).size < 5) return "Use more different characters.";
  if (/^\d+$/.test(pw)) return "Don't use only numbers.";
  return null;
}

export const NewPassword = z
  .string()
  .max(200)
  .superRefine((pw, ctx) => {
    const problem = passwordProblem(pw);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
