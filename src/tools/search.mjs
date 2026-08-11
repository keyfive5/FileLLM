// Content search — the thing File Explorer is worst at.
//
// We narrow candidates with the index first (extension / date / size), then
// actually open and read each one, including inside .docx/.pdf/.xlsx/.pptx.

import path from 'node:path';
import { getIndex } from '../walk.mjs';
import { extractText, isExtractable } from '../extract.mjs';
import { assertReadable, HOME_DIR } from '../safety.mjs';
import { humanBytes, parseDateRange, escapeRegExp, mapLimit, capText } from '../util.mjs';

const DOC_EXTS = ['.doc', '.docx', '.docm', '.pdf', '.txt', '.rtf', '.md', '.odt', '.pages', '.xlsx', '.pptx'];

export async function search_content(args, ctx) {
  const {
    path: target,
    query,
    regex = false,
    case_sensitive = false,
    whole_word = false,
    extensions,
    modified,
    file_type,
    limit = 50,
    max_files_to_open = 6000,
    context_chars = 160,
    include_noise = false,
  } = args;

  if (!query) throw new Error('search_content requires a `query`.');
  const root = assertReadable(target || HOME_DIR);

  const index = await getIndex(root, {
    includeNoise: include_noise,
    onProgress: (p) => ctx?.progress?.(`Indexing ${p.dir} — ${p.files.toLocaleString()} files`),
    isCancelled: ctx?.isCancelled,
  });

  const { from, to } = parseDateRange(modified);

  let exts = null;
  if (extensions?.length) {
    exts = new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  } else if (file_type === 'documents') {
    exts = new Set(DOC_EXTS);
  }

  // Narrow before we touch a single byte of file content.
  const candidates = index.files.filter(([p, size, mtime]) => {
    const ext = path.extname(p).toLowerCase();
    if (exts ? !exts.has(ext) : !isExtractable(ext)) return false;
    if (from != null && mtime < from) return false;
    if (to != null && mtime > to) return false;
    if (size > 64 * 1024 * 1024) return false;
    return true;
  });

  const pattern = regex
    ? new RegExp(query, case_sensitive ? 'g' : 'gi')
    : new RegExp(whole_word ? `\\b${escapeRegExp(query)}\\b` : escapeRegExp(query), case_sensitive ? 'g' : 'gi');

  const toOpen = candidates.slice(0, max_files_to_open);
  const hits = [];
  let opened = 0;
  let unreadable = 0;
  let scannedImagePdfs = 0;

  await mapLimit(toOpen, 12, async ([p, size, mtime]) => {
    if (ctx?.isCancelled?.()) return;
    if (hits.length >= limit * 4) return; // plenty; stop burning I/O

    opened++;
    if (opened % 150 === 0) ctx?.progress?.(`Read ${opened.toLocaleString()} / ${toOpen.length.toLocaleString()} files — ${hits.length} hit${hits.length === 1 ? '' : 's'}`);

    let ex;
    try {
      ex = await extractText(p);
    } catch {
      unreadable++;
      return;
    }
    if (!ex) {
      unreadable++;
      return;
    }
    if (ex.kind === 'pdf' && ex.text.trim() === '') {
      scannedImagePdfs++;
      return;
    }

    pattern.lastIndex = 0;
    const matches = [];
    let m;
    while ((m = pattern.exec(ex.text)) !== null && matches.length < 5) {
      const start = Math.max(0, m.index - Math.floor(context_chars / 2));
      const end = Math.min(ex.text.length, m.index + m[0].length + Math.floor(context_chars / 2));
      matches.push({
        offset: m.index,
        snippet: ex.text.slice(start, end).replace(/\s+/g, ' ').trim(),
        matched: m[0],
      });
      if (m[0].length === 0) pattern.lastIndex++;
    }
    if (matches.length) hits.push({ path: p, size, mtime, kind: ex.kind, matches, total: matches.length });
  });

  hits.sort((a, b) => b.mtime - a.mtime);
  const shown = hits.slice(0, limit);

  const lines = [
    `## "${query}" — ${hits.length} file${hits.length === 1 ? '' : 's'} matched`,
    '',
    `Opened and read **${opened.toLocaleString()}** files under \`${root}\`` +
      `${modified ? ` filtered to ${modified}` : ''}` +
      `${exts ? ` (${[...exts].join(', ')})` : ''}.`,
    '',
  ];

  if (shown.length) {
    for (const h of shown) {
      lines.push(
        `### \`${h.path}\``,
        `${humanBytes(h.size)} · modified ${new Date(h.mtime).toISOString().slice(0, 10)} · read as ${h.kind}`,
        ''
      );
      for (const m of h.matches) lines.push(`> …${m.snippet}…`);
      lines.push('');
    }
    if (hits.length > shown.length) lines.push(`_…and ${hits.length - shown.length} more matching files._`, '');
  } else {
    lines.push('_No matches._', '');
  }

  const notes = [];
  if (candidates.length > toOpen.length) {
    notes.push(`${(candidates.length - toOpen.length).toLocaleString()} candidate files were not opened (hit the ${max_files_to_open} file cap) — narrow the filters or raise \`max_files_to_open\`.`);
  }
  if (scannedImagePdfs) notes.push(`${scannedImagePdfs} PDF(s) contained no text layer — they are scans/images and would need OCR.`);
  if (unreadable) notes.push(`${unreadable} file(s) could not be read as text.`);
  if (notes.length) lines.push('---', ...notes.map((n) => `_${n}_`));

  return {
    content: capText(lines.join('\n')),
    data: { root, query, filesOpened: opened, matchCount: hits.length, hits: shown },
  };
}

export async function read_file({ path: target, max_chars = 4000, offset = 0 }) {
  const abs = assertReadable(target);
  const ex = await extractText(abs);
  if (!ex) return { content: `Could not extract text from \`${abs}\` — it is a binary format with no readable text layer.` };

  const slice = ex.text.slice(offset, offset + max_chars);
  const more = ex.text.length > offset + max_chars;

  return {
    content: [
      `## ${path.basename(abs)}`,
      `\`${abs}\` · read as ${ex.kind} · ${ex.text.length.toLocaleString()} characters of text`,
      '',
      '```',
      slice || '(no text at this offset)',
      '```',
      more ? `\n_Showing characters ${offset}–${offset + slice.length}. Call again with a higher \`offset\` for more._` : '',
    ].join('\n'),
    data: { path: abs, kind: ex.kind, totalChars: ex.text.length },
  };
}

export async function list_directory({ path: target, limit = 200 }) {
  const abs = assertReadable(target);
  const { readdirSync, statSync } = await import('node:fs');
  const entries = readdirSync(abs, { withFileTypes: true });

  const rows = [];
  for (const e of entries.slice(0, limit)) {
    const full = path.join(abs, e.name);
    const st = statSync(full, { throwIfNoEntry: false });
    rows.push({
      name: e.name,
      isDir: e.isDirectory(),
      size: st && e.isFile() ? st.size : null,
      mtime: st ? st.mtimeMs : 0,
    });
  }
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const lines = [`## ${abs}`, '', `${entries.length} entries`, '', '| Type | Size | Modified | Name |', '| --- | --- | --- | --- |'];
  for (const r of rows) {
    lines.push(`| ${r.isDir ? 'dir' : 'file'} | ${r.size == null ? '—' : humanBytes(r.size)} | ${new Date(r.mtime).toISOString().slice(0, 10)} | \`${r.name}\` |`);
  }
  if (entries.length > rows.length) lines.push('', `_…and ${entries.length - rows.length} more entries._`);

  return { content: lines.join('\n'), data: { path: abs, entries: rows } };
}
