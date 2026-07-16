import { createHash } from "node:crypto";

/**
 * Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF.
 * Deliberately dependency-free — bank exports are simple and small.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export interface CsvRow {
  line: number;
  postedAt: string;
  merchantName: string;
  amountCents: number;
  categoryName: string | null;
  description: string | null;
  externalId: string;
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: Array<{ line: number; message: string }>;
}

const HEADER_ALIASES: Record<string, string> = {
  date: "date",
  "posted at": "date",
  "transaction date": "date",
  merchant: "merchant",
  payee: "merchant",
  name: "merchant",
  description: "description",
  memo: "description",
  notes: "description",
  amount: "amount",
  category: "category",
  "external id": "externalId",
  external_id: "externalId",
  id: "externalId",
};

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US bank exports: MM/DD/YYYY
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/**
 * Parse a bank-export CSV into importable rows. Rows without an external id
 * get a deterministic hash of (date, merchant, amount, per-file occurrence
 * counter): re-importing the same file is a no-op, while two genuinely
 * identical purchases within one file are preserved.
 */
export function parseTransactionsCsv(text: string): CsvParseResult {
  const raw = parseCsv(text);
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: "Empty file." }] };

  const header = raw[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  const col = (name: string) => header.indexOf(name);
  if (col("date") === -1 || col("amount") === -1 || col("merchant") === -1) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message:
            'Header must include "date", "merchant" (or "payee"/"name"), and "amount" columns.',
        },
      ],
    };
  }

  const rows: CsvRow[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const occurrence = new Map<string, number>();

  for (let i = 1; i < raw.length; i++) {
    const line = i + 1;
    const cells = raw[i]!;
    const get = (name: string) => {
      const idx = col(name);
      return idx === -1 ? "" : (cells[idx] ?? "").trim();
    };

    const postedAt = parseDate(get("date"));
    if (!postedAt) {
      errors.push({ line, message: `Unrecognized date "${get("date")}".` });
      continue;
    }
    const amountCents = parseAmount(get("amount"));
    if (amountCents === null || amountCents === 0) {
      errors.push({ line, message: `Unrecognized amount "${get("amount")}".` });
      continue;
    }
    const merchantName = get("merchant");
    if (!merchantName) {
      errors.push({ line, message: "Missing merchant." });
      continue;
    }

    let externalId = get("externalId");
    if (!externalId) {
      const key = `${postedAt}|${merchantName}|${amountCents}`;
      const n = (occurrence.get(key) ?? 0) + 1;
      occurrence.set(key, n);
      externalId =
        "csv-" +
        createHash("sha256").update(`${key}|${n}`).digest("hex").slice(0, 24);
    }

    rows.push({
      line,
      postedAt,
      merchantName,
      amountCents,
      categoryName: get("category") || null,
      description: get("description") || null,
      externalId,
    });
  }

  return { rows, errors };
}
