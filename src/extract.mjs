// Pull readable text out of the formats people actually keep documents in.
// File Explorer's content search only works on indexed locations and silently
// misses most of these; we just open the bytes and read them.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { readZipDirectory, readZipEntry, listZipEntries } from './zip.mjs';

export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.ini', '.cfg', '.conf', '.env', '.rtf', '.srt', '.vtt', '.sql', '.tex', '.bib',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bat', '.ps1', '.pl', '.lua', '.r', '.m', '.vb', '.gradle', '.toml',
]);

export const OFFICE_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);
export const PDF_EXTENSIONS = new Set(['.pdf']);

/** Extensions we can read text from at all. Used to pre-filter candidates. */
export function isExtractable(ext) {
  const e = ext.toLowerCase();
  return TEXT_EXTENSIONS.has(e) || OFFICE_EXTENSIONS.has(e) || PDF_EXTENSIONS.has(e);
}

/**
 * @returns {Promise<{text:string, kind:string, truncated:boolean}|null>}
 * null means "this file has no extractable text" — not an error.
 */
export async function extractText(filePath, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const ext = path.extname(filePath).toLowerCase();

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return { text: '', kind: 'empty', truncated: false };
  if (stat.size > maxBytes) {
    if (TEXT_EXTENSIONS.has(ext)) {
      const fh = await fs.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        return { text: decodeText(buf.subarray(0, bytesRead)), kind: 'text', truncated: true };
      } finally {
        await fh.close();
      }
    }
    return null; // Refuse to load a multi-GB binary into memory.
  }

  const buf = await fs.readFile(filePath);

  if (OFFICE_EXTENSIONS.has(ext)) {
    const text = extractOffice(buf, ext);
    return text == null ? null : { text, kind: ext.slice(1), truncated: false };
  }
  if (PDF_EXTENSIONS.has(ext)) {
    const text = extractPdf(buf);
    return text == null ? null : { text, kind: 'pdf', truncated: false };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return { text: decodeText(buf), kind: 'text', truncated: false };
  }

  // Unknown extension: sniff it. Plenty of useful files have no extension at all.
  if (looksLikeText(buf)) return { text: decodeText(buf), kind: 'text?', truncated: false };
  return null;
}

/** Decode with BOM detection, falling back to UTF-8 then latin1. */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  // Heuristic for BOM-less UTF-16LE (very common in PowerShell output / Notepad):
  // ASCII text encoded as UTF-16LE has a zero in every odd byte position.
  if (buf.length >= 4 && buf.length % 2 === 0) {
    const probe = Math.min(buf.length, 512);
    let oddZeros = 0;
    let checked = 0;
    for (let i = 1; i < probe; i += 2) {
      checked++;
      if (buf[i] === 0) oddZeros++;
    }
    if (checked && oddZeros / checked > 0.7) return buf.toString('utf16le');
  }

  const utf8 = buf.toString('utf8');
  // U+FFFD storm means it wasn't really UTF-8.
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > utf8.length * 0.02) return buf.toString('latin1');
  return utf8;
}

export function looksLikeText(buf) {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n < 0.1;
}

// ---------------------------------------------------------------- OOXML

function extractOffice(buf, ext) {
  let dir;
  try {
    dir = readZipDirectory(buf);
  } catch {
    return null;
  }

  const get = (name) => {
    const b = readZipEntry(buf, dir, name);
    return b ? b.toString('utf8') : null;
  };

  if (ext === '.docx' || ext === '.docm') {
    const parts = [get('word/document.xml')];
    // Headers, footers and footnotes hold real content people search for.
    for (const n of listZipEntries(dir, (n) => /^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/.test(n))) {
      parts.push(get(n));
    }
    const xml = parts.filter(Boolean).join('\n');
    if (!xml) return null;
    return xmlToText(xml, { blockTags: ['w:p', 'w:tr'], tabTags: ['w:tab'], breakTags: ['w:br'] });
  }

  if (ext === '.pptx' || ext === '.pptm') {
    const slides = listZipEntries(dir, (n) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n)).sort(naturalSort);
    const out = [];
    for (const n of slides) {
      const xml = get(n);
      if (!xml) continue;
      out.push(`--- ${path.basename(n, '.xml')} ---`);
      out.push(xmlToText(xml, { blockTags: ['a:p'], breakTags: ['a:br'] }));
    }
    return out.join('\n') || null;
  }

  if (ext === '.xlsx' || ext === '.xlsm') {
    const shared = [];
    const ss = get('xl/sharedStrings.xml');
    if (ss) {
      for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push(xmlToText(m[1], { blockTags: [] }).replace(/\s+/g, ' ').trim());
      }
    }
    const sheets = listZipEntries(dir, (n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort(naturalSort);
    const out = [];
    for (const n of sheets) {
      const xml = get(n);
      if (!xml) continue;
      out.push(`--- ${path.basename(n, '.xml')} ---`);
      for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
          const isShared = /\bt="s"/.test(c[1]);
          const isInline = /\bt="(?:inlineStr|str)"/.test(c[1]);
          const v = c[2].match(/<v>([\s\S]*?)<\/v>/);
          if (isShared && v) cells.push(shared[+v[1]] ?? '');
          else if (isInline) cells.push(xmlToText(c[2], { blockTags: [] }).trim());
          else if (v) cells.push(decodeEntities(v[1]));
        }
        if (cells.some((x) => x !== '')) out.push(cells.join('\t'));
      }
    }
    return out.join('\n') || null;
  }

  return null;
}

/** Strip XML to readable text, turning paragraph-ish tags into newlines. */
function xmlToText(xml, { blockTags = [], tabTags = [], breakTags = [] } = {}) {
  let s = xml;
  for (const t of breakTags) s = s.replaceAll(`<${t}/>`, '\n').replaceAll(`<${t}>`, '\n');
  for (const t of tabTags) s = s.replaceAll(`<${t}/>`, '\t').replaceAll(`<${t}>`, '\t');
  for (const t of blockTags) s = s.replaceAll(`</${t}>`, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

// ------------------------------------------------------------------ PDF

/**
 * Best-effort PDF text extraction: inflate every FlateDecode stream, then read
 * the text-showing operators. This handles the large majority of real-world
 * text PDFs (Word/LaTeX/Chrome exports). It does NOT handle scanned pages,
 * which are images and would need OCR — callers surface that distinction.
 */
function extractPdf(buf) {
  const chunks = [];

  // Walk `stream ... endstream` pairs directly; a full xref parse buys us
  // little here and breaks on the many slightly-malformed PDFs in the wild.
  let pos = 0;
  const STREAM = Buffer.from('stream');
  const ENDSTREAM = Buffer.from('endstream');

  while (pos < buf.length) {
    const s = buf.indexOf(STREAM, pos);
    if (s === -1) break;
    // Guard against matching the tail of "endstream".
    if (s >= 3 && buf.toString('latin1', s - 3, s) === 'end') {
      pos = s + 6;
      continue;
    }
    const dictStart = Math.max(0, s - 800);
    const dict = buf.toString('latin1', dictStart, s);

    let d = s + STREAM.length;
    if (buf[d] === 0x0d) d++;
    if (buf[d] === 0x0a) d++;

    const e = buf.indexOf(ENDSTREAM, d);
    if (e === -1) break;

    const raw = buf.subarray(d, e);
    pos = e + ENDSTREAM.length;

    // Skip streams that are clearly not page content.
    if (/\/Subtype\s*\/Image/.test(dict) || /\/Type\s*\/(XRef|Metadata|EmbeddedFile)/.test(dict)) continue;

    let data = raw;
    if (/\/Filter[^>]*\/FlateDecode/.test(dict)) {
      data = tryInflate(raw);
      if (!data) continue;
    } else if (/\/Filter/.test(dict)) {
      continue; // DCTDecode / JPXDecode / etc. — not text.
    }

    const text = pdfContentToText(data);
    if (text) chunks.push(text);
  }

  const joined = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (joined) return joined;

  // Nothing decoded — most likely a scanned/image-only PDF.
  return '';
}

function tryInflate(raw) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(raw);
    } catch {}
    try {
      return fn(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {}
  }
  return null;
}

/** Read Tj / TJ / ' / " operators out of a decoded content stream. */
function pdfContentToText(data) {
  const s = data.toString('latin1');
  if (!/\bTj|\bTJ|\bTd|\bTm/.test(s)) return '';

  const out = [];
  let i = 0;
  let pending = [];

  const flush = (newline) => {
    if (pending.length) {
      out.push(pending.join(''));
      pending = [];
    }
    if (newline && out.length && out[out.length - 1] !== '\n') out.push('\n');
  };

  while (i < s.length) {
    const c = s[i];

    if (c === '(') {
      const { text, next } = readPdfLiteral(s, i);
      pending.push(text);
      i = next;
      continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end === -1) break;
      pending.push(decodePdfHex(s.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    // Operators that end a line of text.
    if (c === 'T' && (s[i + 1] === 'd' || s[i + 1] === 'D' || s[i + 1] === '*')) {
      flush(true);
      i += 2;
      continue;
    }
    if (s.startsWith('ET', i)) {
      flush(true);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      flush(true);
      i += 1;
      continue;
    }
    i++;
  }
  flush(false);

  return out
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readPdfLiteral(s, start) {
  let i = start + 1;
  let depth = 1;
  let text = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'n') text += '\n';
      else if (n === 'r') text += '\r';
      else if (n === 't') text += '\t';
      else if (n === 'b') text += '\b';
      else if (n === 'f') text += '\f';
      else if (n === '\n') { /* line continuation */ }
      else if (n >= '0' && n <= '7') {
        const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        text += String.fromCharCode(parseInt(oct, 8));
        i += oct.length + 1;
        continue;
      } else text += n;
      i += 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return { text, next: i + 1 };
    }
    text += c;
    i++;
  }
  return { text, next: i };
}

function decodePdfHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return '';
  // 4-hex-digit groups are usually UTF-16BE (or CIDs that happen to map to it).
  if (clean.length % 4 === 0 && /^(00|0[1-9a-fA-F]|[0-9a-fA-F]{2})/.test(clean)) {
    let looksUtf16 = true;
    for (let i = 0; i < clean.length && looksUtf16; i += 4) {
      const hi = parseInt(clean.slice(i, i + 2), 16);
      if (hi > 0x2f) looksUtf16 = false;
    }
    if (looksUtf16) {
      let s = '';
      for (let i = 0; i + 4 <= clean.length; i += 4) {
        const cp = parseInt(clean.slice(i, i + 4), 16);
        if (cp >= 32 || cp === 10 || cp === 9) s += String.fromCharCode(cp);
      }
      return s;
    }
  }
  let s = '';
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return s;
}
