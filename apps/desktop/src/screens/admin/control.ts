import {
  ControlFamilyListResponse,
  CreateFamilyResponse,
  type CreateFamilyRequest,
} from "@vault/shared";
import { z } from "zod";
import { getPlatform } from "../../platform/index.js";

const URL_KEY = "admin.controlUrl";
const TOKEN_KEY = "admin.controlToken";

export interface ControlConnection {
  url: string;
  token: string;
}

export async function loadConnection(): Promise<ControlConnection | null> {
  const platform = await getPlatform();
  const url = await platform.loadValue(URL_KEY);
  const token = await platform.getSecret(TOKEN_KEY);
  return url && token ? { url, token } : null;
}

export async function saveConnection(conn: ControlConnection): Promise<void> {
  const platform = await getPlatform();
  await platform.saveValue(URL_KEY, conn.url);
  await platform.setSecret(TOKEN_KEY, conn.token);
}

export async function clearConnection(): Promise<void> {
  const platform = await getPlatform();
  await platform.deleteValue(URL_KEY);
  await platform.deleteSecret(TOKEN_KEY);
}

/** Trust-on-first-use for the control plane's self-signed cert (same as the app). */
export async function probeAndTrust(url: string): Promise<{ trusted: boolean; fingerprint?: string }> {
  const platform = await getPlatform();
  const origin = new URL(url).origin;
  const probe = await platform.probeServer(origin);
  if (!probe.reachable) throw new Error("Couldn't reach that address.");
  if (probe.trustedByOs) return { trusted: true };
  const existing = await platform.getPin(origin);
  if (existing) return { trusted: true };
  return { trusted: false, ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {}) };
}

export async function trust(url: string, fingerprint: string | null): Promise<void> {
  const platform = await getPlatform();
  await platform.trustServer(new URL(url).origin, fingerprint);
}

class ControlError extends Error {}

async function call<T>(
  conn: ControlConnection,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const platform = await getPlatform();
  const res = await platform.fetchImpl(`${conn.url.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${conn.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status >= 400) {
    let msg = `Request failed (${res.status}).`;
    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {
      /* keep default */
    }
    throw new ControlError(msg);
  }
  return schema.parse(text ? JSON.parse(text) : undefined);
}

export const control = {
  families: (c: ControlConnection) =>
    call(c, "GET", "/control/families", ControlFamilyListResponse),
  createFamily: (c: ControlConnection, body: CreateFamilyRequest) =>
    call(c, "POST", "/control/families", CreateFamilyResponse, body),
  updateFamily: (c: ControlConnection, slug: string) =>
    call(c, "POST", `/control/families/${slug}/update`, z.object({ ok: z.boolean(), log: z.string() })),
  destroyFamily: (c: ControlConnection, slug: string) =>
    call(
      c,
      "DELETE",
      `/control/families/${slug}`,
      z.object({ ok: z.boolean(), log: z.string() }),
      { confirm: slug },
    ),
};
