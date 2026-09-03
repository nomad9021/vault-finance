import { z } from "zod";

/** One hosted family instance as the control-plane sees it. */
export const ControlFamily = z.object({
  slug: z.string(),
  port: z.string(),
  mode: z.enum(["port", "proxy"]),
  domain: z.string().nullable(),
  state: z.string(), // docker container state, or "-" when not running
  dbSize: z.string(),
  ownerEmail: z.string().nullable(),
  appPublicUrl: z.string().nullable(),
  runningVersion: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type ControlFamily = z.infer<typeof ControlFamily>;

export const ControlFamilyListResponse = z.object({
  families: z.array(ControlFamily),
  latestVersion: z.string().nullable(),
});
export type ControlFamilyListResponse = z.infer<typeof ControlFamilyListResponse>;

export const CreateFamilyRequest = z.object({
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9]{1,30}$/, "lowercase letters/digits, starts with a letter"),
  ownerEmail: z.string().email().optional(),
  mode: z.enum(["port", "proxy"]).default("port"),
  domain: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type CreateFamilyRequest = z.infer<typeof CreateFamilyRequest>;

export const CreateFamilyResponse = z.object({
  slug: z.string(),
  connectUrl: z.string(),
  welcomeEmailSent: z.boolean(),
});
export type CreateFamilyResponse = z.infer<typeof CreateFamilyResponse>;

export const ControlActionResponse = z.object({
  ok: z.boolean(),
  log: z.string(),
});
export type ControlActionResponse = z.infer<typeof ControlActionResponse>;
