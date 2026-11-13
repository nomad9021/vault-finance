import type { ChatAttachment } from "@vault/shared";

/**
 * A spreadsheet attached to a chat message, tidied for the model: parsed
 * (comma, semicolon or tab separated), blank rows and columns dropped, cells
 * trimmed, then written back as one row per line with " | " between cells
 * and a row number, which small models read more reliably than raw CSV.
 * Capped so a huge sheet can't swamp the context.
 */

const MAX_ROWS = 400;
const MAX_CHARS = 40_000;
const MAX_CELL = 80;

export function parseDelimited(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = [",", ";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const clean = (cell: string) => {
  const c = cell.replace(/\s+/g, " ").trim();
  return c.length > MAX_CELL ? `${c.slice(0, MAX_CELL)}…` : c;
};

/** The sheet as numbered rows, plus how many rows were left out. */
export function tidySheet(text: string): { lines: string[]; rows: number; omitted: number } {
  const parsed = parseDelimited(text.replace(/^﻿/, "")).map((r) => r.map(clean));
  const rows = parsed.filter((r) => r.some((c) => c !== ""));
  // Drop columns that are empty in every row.
  const width = Math.max(0, ...rows.map((r) => r.length));
  const keep = Array.from({ length: width }, (_, i) => i).filter((i) => rows.some((r) => (r[i] ?? "") !== ""));
  const lines: string[] = [];
  let chars = 0;
  for (const [n, r] of rows.entries()) {
    if (lines.length >= MAX_ROWS) break;
    // Trailing empty cells say nothing.
    const cells = keep.map((i) => r[i] ?? "");
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    const line = `${n + 1}: ${cells.join(" | ")}`;
    if (chars + line.length > MAX_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return { lines, rows: rows.length, omitted: rows.length - lines.length };
}

/** Strip characters that could close or fake the block it's kept in. */
const safeName = (name: string) => name.replace(/["<>\n\r]/g, "").slice(0, 120) || "spreadsheet";

/** The block a user message carries its attachment in (see FILE_BLOCK_RE in @vault/shared). */
export function fileBlock(att: ChatAttachment): string {
  const { lines, rows, omitted } = tidySheet(att.content);
  const body = lines.map((l) => l.replace(/<\/?vault-[a-z]+/gi, "")).join("\n");
  return [
    "",
    "",
    `<vault-file name="${safeName(att.name)}" rows="${rows}">`,
    `Attached spreadsheet "${safeName(att.name)}" — ${rows} row${rows === 1 ? "" : "s"}, one per line as "row: cell | cell | …":`,
    body || "(empty)",
    ...(omitted > 0 ? [`(${omitted} more rows not shown — the sheet is too long; ask the user to split it.)`] : []),
    "</vault-file>",
  ].join("\n");
}
