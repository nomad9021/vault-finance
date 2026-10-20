import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AiMemoryNote } from "@vault/shared";
import { decryptSecret, encryptSecret } from "../secret-crypto.js";

/**
 * The assistant's long-term memory: one append-only file per user at
 * `<data dir>/ai-memory/<user id>.jsonl`. It is never deleted or trimmed —
 * not by the retention purge, and not when the user deletes chats (the user
 * asked for exactly that). It lives in the data folder, so the encrypted
 * server backup (installers/server/backup-server.sh) includes it.
 *
 * Each line is `{"at": ISO time, "note": <encrypted text>}`. Notes are
 * encrypted with the data key like other sensitive values, because they are
 * facts about the household's finances; rotate-data-key re-encrypts them.
 */

const DIR = "ai-memory";
/** How many of the newest notes go into the model's prompt. */
export const MEMORY_PROMPT_LIMIT = 60;

function memoryDir(dataDir: string): string {
  return path.join(dataDir, DIR);
}

function fileFor(dataDir: string, userId: string): string {
  // userId is a uuid from the session, but never trust it as a path segment.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("invalid user id");
  return path.join(memoryDir(dataDir), `${userId}.jsonl`);
}

export function appendMemory(dataDir: string, userId: string, notes: string[], now = new Date()): void {
  if (notes.length === 0) return;
  mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
  const lines = notes.map((text) => JSON.stringify({ at: now.toISOString(), note: encryptSecret(text) }) + "\n");
  appendFileSync(fileFor(dataDir, userId), lines.join(""), { mode: 0o600 });
}

export function readMemory(dataDir: string, userId: string): AiMemoryNote[] {
  const file = fileFor(dataDir, userId);
  if (!existsSync(file)) return [];
  const notes: AiMemoryNote[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { at: string; note: string };
      notes.push({ at: row.at, text: decryptSecret(row.note) });
    } catch {
      // A torn last line (crash mid-append) or a foreign key — skip it, keep the rest.
    }
  }
  return notes;
}

/**
 * Key rotation, step 1: decrypt every memory file (`decrypt` tries the old and
 * any pending new key — see rotate.ts) into plaintext held in memory.
 */
export function loadAllMemory(
  dataDir: string,
  decrypt: (v: string) => string,
): { file: string; rows: { at: string; text: string }[] }[] {
  const dir = memoryDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = path.join(dir, name);
      const rows = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          let row: { at: string; note: string };
          try {
            row = JSON.parse(line) as { at: string; note: string };
          } catch {
            return []; // torn line from a crash mid-append — nothing recoverable in it
          }
          // A decrypt failure throws on purpose: rotation must not drop notes.
          return [{ at: row.at, text: decrypt(row.note) }];
        });
      return { file, rows };
    });
}

/**
 * Key rotation, step 2: write the files back under the key now configured,
 * via a temp file + rename so a crash never leaves a half-written file.
 */
export function saveAllMemory(loaded: ReturnType<typeof loadAllMemory>): number {
  let count = 0;
  for (const { file, rows } of loaded) {
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      rows.map((r) => JSON.stringify({ at: r.at, note: encryptSecret(r.text) }) + "\n").join(""),
      { mode: 0o600 },
    );
    renameSync(tmp, file);
    count += rows.length;
  }
  return count;
}
