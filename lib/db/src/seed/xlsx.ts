/**
 * A small .xlsx reader — enough to turn a workbook into string grids the CSV
 * importer already understands. No dependency: an .xlsx is a zip of XML, so
 * this walks the zip central directory, inflates the parts it needs, and
 * reads shared strings, number formats and each sheet's cells.
 *
 * `inflate` is injected so the same code runs on the server (node:zlib) and
 * in the browser demo (DecompressionStream).
 */

export type Inflate = (deflated: Uint8Array) => Promise<Uint8Array>;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

const td = new TextDecoder('utf-8');
const u16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

function zipEntries(buf: Uint8Array): ZipEntry[] {
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip/xlsx file');
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('Bad zip central directory');
    const method = u16(buf, p + 10);
    const compressedSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const offset = u32(buf, p + 42);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: Uint8Array, e: ZipEntry, inflate: Inflate): Promise<string> {
  if (u32(buf, e.offset) !== 0x04034b50) throw new Error(`Bad zip entry ${e.name}`);
  const nameLen = u16(buf, e.offset + 26);
  const extraLen = u16(buf, e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return td.decode(data);
  if (e.method === 8) return td.decode(await inflate(data));
  throw new Error(`Unsupported zip compression ${e.method} in ${e.name}`);
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Shared strings, rich text flattened. */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) out.push([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join(''));
  return out;
}

/** Which cell styles (xf index) are dates, by their number format. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    custom.set(id, code);
  }
  const isDateFmt = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmy]/i.test((custom.get(id) ?? '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')) && !/[#0]/.test(custom.get(id) ?? '');
  const out = new Set<number>();
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  [...xfs.matchAll(/<xf\s[^>]*>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    if (isDateFmt(id)) out.add(i);
  });
  return out;
}

/** Excel serial → M/D/YYYY, which the CSV importer's date parser accepts. */
export function serialToDate(n: number): string {
  const ms = Math.round((n - 25569) * 86_400_000);
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetGrid(xml: string, strings: string[], dates: Set<number>): string[][] {
  const grid: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = ` ${c[1]}`;
      const ref = attr(head, 'r') ?? '';
      const type = attr(head, 't');
      const style = Number(attr(head, 's') ?? '-1');
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's' && v !== undefined) text = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') text = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join('');
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        text = type === 'str' || type === 'e' ? unescape(v) : dates.has(style) && /^-?\d+(\.\d+)?$/.test(v) ? serialToDate(Number(v)) : v;
      }
      const i = colIndex(ref);
      while (cells.length < i) cells.push('');
      cells[i] = text;
    }
    grid.push(cells);
  }
  return grid;
}

export interface Workbook {
  sheets: Array<{ name: string; grid: string[][] }>;
}

export async function readXlsx(buf: Uint8Array, inflate: Inflate): Promise<Workbook> {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (name: string) => {
    const e = byName.get(name);
    return e ? readEntry(buf, e, inflate) : '';
  };
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('This file is not an Excel workbook (no xl/workbook.xml)');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) relTarget.set(attr(m[0], 'Id') ?? '', attr(m[0], 'Target') ?? '');
  const strings = sharedStrings(await read('xl/sharedStrings.xml'));
  const dates = dateStyles(await read('xl/styles.xml'));
  const sheets: Workbook['sheets'] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = unescape(attr(m[0], 'name') ?? 'Sheet');
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id') ?? '';
    const target = (relTarget.get(rid) ?? '').replace(/^\//, '').replace(/^xl\//, '');
    const xml = await read(`xl/${target}`);
    sheets.push({ name, grid: xml ? sheetGrid(xml, strings, dates) : [] });
  }
  return { sheets };
}

/** Base64 (with or without a data: prefix) → bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
