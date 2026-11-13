/**
 * Read a spreadsheet the person picks (to hand to the assistant) as CSV text.
 * CSV, TSV and plain text are read as they are; Excel .xlsx files are opened
 * here — an .xlsx is a zip of XML, so a small zip reader and the browser's
 * own inflate (DecompressionStream) are enough, with no library. Every sheet
 * with data comes through, each under a "# Sheet: name" line. Google Sheets,
 * Numbers and Excel can all save as either format.
 */

export const SPREADSHEET_ACCEPT = ".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BYTES = 5_000_000;
/** What the server accepts in one attachment. */
export const MAX_CONTENT = 200_000;

export class SpreadsheetError extends Error {}

export async function readSpreadsheet(file: File): Promise<{ name: string; content: string }> {
  if (file.size > MAX_BYTES) throw new SpreadsheetError("That file is too big — keep it under 5 MB.");
  const lower = file.name.toLowerCase();
  let content: string;
  if (lower.endsWith(".xlsx")) content = await xlsxToCsv(new Uint8Array(await file.arrayBuffer()));
  else if (lower.endsWith(".xls") || lower.endsWith(".numbers") || lower.endsWith(".ods")) {
    throw new SpreadsheetError("Save it as .xlsx or .csv first (File → Export or Save As), then attach that.");
  } else content = await file.text();
  content = content.replace(/^﻿/, "").trim();
  if (!content) throw new SpreadsheetError("That spreadsheet looks empty.");
  if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
  return { name: file.name.slice(0, 200), content };
}

// ── zip ──

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

function zipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError("That doesn't look like an Excel file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    out.push({ name: dec.decode(buf.subarray(p + 46, p + 46 + nameLen)), method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = buf.slice(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new SpreadsheetError("That Excel file uses compression the app can't read; save it as CSV.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

// ── xlsx ──

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const textOf = (el: Element) => Array.from(el.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("");

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * How a cell's number is shown in Excel, from its style: as a date, a
 * percentage, or a plain number. Without this a date reads as 46266 and 15%
 * as 0.15, and the assistant has to guess.
 */
type NumKind = "date" | "percent" | "number";

function numberKinds(stylesXml: string | null): NumKind[] {
  if (!stylesXml) return [];
  const doc = xml(stylesXml);
  const custom = new Map<string, string>();
  for (const f of Array.from(doc.getElementsByTagName("numFmt"))) custom.set(f.getAttribute("numFmtId") ?? "", f.getAttribute("formatCode") ?? "");
  const kindOf = (id: number): NumKind => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return "date";
    if (id === 9 || id === 10) return "percent";
    const code = custom.get(String(id));
    if (!code) return "number";
    // Ignore quoted text, escapes and [colour]/[locale] parts before looking.
    const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
    if (/%/.test(bare)) return "percent";
    if (/[dmyhs]/i.test(bare) && !/[#0?]/.test(bare.replace(/[dmyhs:/\-. ]/gi, ""))) return "date";
    return "number";
  };
  const xfs = doc.getElementsByTagName("cellXfs")[0];
  return xfs ? Array.from(xfs.getElementsByTagName("xf")).map((x) => kindOf(Number(x.getAttribute("numFmtId") ?? 0))) : [];
}

/** Excel's day count (1900 date system) to YYYY-MM-DD. */
export function excelDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

/** Formula results carry float noise (3180.903667): two decimals is enough for money. */
export function tidyNumber(v: string, kind: NumKind): string {
  const n = Number(v);
  if (v === "" || !Number.isFinite(n)) return v;
  if (kind === "date" && n > 0 && n < 2_958_466) return excelDate(n);
  if (kind === "percent") return `${Number((n * 100).toFixed(2))}%`;
  return String(Number(n.toFixed(2)));
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function xlsxToCsv(buf: Uint8Array): Promise<string> {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (name: string) => {
    const e = byName.get(name);
    return e ? await readEntry(buf, e) : null;
  };

  const shared: string[] = [];
  const sst = await read("xl/sharedStrings.xml");
  if (sst) for (const si of Array.from(xml(sst).getElementsByTagName("si"))) shared.push(textOf(si));

  // Sheets in workbook order, with their names.
  const sheets: Array<{ name: string; path: string }> = [];
  const wb = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const target = new Map(
      Array.from(xml(rels).getElementsByTagName("Relationship")).map((r) => [r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? ""]),
    );
    for (const s of Array.from(xml(wb).getElementsByTagName("sheet"))) {
      const rid = s.getAttribute("r:id") ?? s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
      const t = target.get(rid);
      if (t) sheets.push({ name: s.getAttribute("name") ?? "Sheet", path: t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}` });
    }
  }
  if (sheets.length === 0) {
    for (const e of entries.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      sheets.push({ name: e.name.replace(/^.*\/|\.xml$/g, ""), path: e.name });
    }
  }

  const kinds = numberKinds(await read("xl/styles.xml"));
  const parts: string[] = [];
  for (const sheet of sheets.slice(0, 5)) {
    const text = await read(sheet.path);
    if (!text) continue;
    const lines: string[] = [];
    for (const row of Array.from(xml(text).getElementsByTagName("row"))) {
      const cells: string[] = [];
      for (const c of Array.from(row.getElementsByTagName("c"))) {
        const i = colIndex(c.getAttribute("r") ?? "");
        const type = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        const value =
          type === "s"
            ? (shared[Number(v)] ?? "")
            : type === "inlineStr"
              ? textOf(c)
              : type === "b"
                ? v === "1" ? "TRUE" : "FALSE"
                : type === "str" || type === "e"
                  ? v
                  : tidyNumber(v, kinds[Number(c.getAttribute("s") ?? 0)] ?? "number");
        while (cells.length < i) cells.push("");
        cells[i] = value.trim();
      }
      if (cells.some((x) => x !== "")) lines.push(cells.map(csvCell).join(","));
    }
    if (lines.length) parts.push(...(sheets.length > 1 ? [`# Sheet: ${sheet.name}`] : []), ...lines);
  }
  if (!parts.length) throw new SpreadsheetError("That spreadsheet looks empty.");
  return parts.join("\n");
}
