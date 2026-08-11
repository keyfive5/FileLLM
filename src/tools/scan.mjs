// Storage analysis + file finding.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getIndex, rollupDirs, NOISE_DIRS } from '../walk.mjs';
import { listDrives, assertReadable, HOME_DIR } from '../safety.mjs';
import { humanBytes, parseDateRange, globToRegExp } from '../util.mjs';

/** Where Windows hides reclaimable space, with a risk rating for each. */
function junkCandidates() {
  const LOCAL = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
  const ROAMING = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');
  const WIN = process.env.SystemRoot || 'C:\\Windows';

  return [
    { path: path.join(LOCAL, 'Temp'), label: 'User temp files', risk: 'safe', note: 'Scratch files apps forgot to clean up. Safe to clear; close apps first.' },
    { path: path.join(WIN, 'Temp'), label: 'Windows temp files', risk: 'safe', note: 'System scratch space. Some entries may be locked while in use.' },
    { path: path.join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), label: 'Chrome cache', risk: 'safe', note: 'Rebuilds itself. Sites reload a little slower once.' },
    { path: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), label: 'Edge cache', risk: 'safe', note: 'Rebuilds itself.' },
    { path: path.join(LOCAL, 'Mozilla', 'Firefox', 'Profiles'), label: 'Firefox profiles (incl. cache)', risk: 'careful', note: 'Contains bookmarks and logins as well as cache — do not delete wholesale.' },
    { path: path.join(LOCAL, 'CrashDumps'), label: 'Crash dumps', risk: 'safe', note: 'Only useful if you are actively debugging a crash.' },
    { path: path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer'), label: 'Explorer thumbnail cache', risk: 'safe', note: 'Regenerates on demand.' },
    { path: path.join(LOCAL, 'Packages'), label: 'Store app data & caches', risk: 'careful', note: 'Holds app settings too. Only clear the LocalCache subfolders.' },
    { path: path.join(LOCAL, 'npm-cache'), label: 'npm cache', risk: 'safe', note: 'Re-downloads when needed.' },
    { path: path.join(LOCAL, 'pip', 'Cache'), label: 'pip cache', risk: 'safe', note: 'Re-downloads when needed.' },
    { path: path.join(LOCAL, 'Yarn', 'Cache'), label: 'Yarn cache', risk: 'safe', note: 'Re-downloads when needed.' },
    { path: path.join(HOME_DIR, '.cargo', 'registry'), label: 'Rust cargo registry cache', risk: 'safe', note: 'Re-downloads when needed.' },
    { path: path.join(HOME_DIR, '.gradle', 'caches'), label: 'Gradle caches', risk: 'safe', note: 'Re-downloads when needed; next build is slower.' },
    { path: path.join(HOME_DIR, '.nuget', 'packages'), label: 'NuGet packages cache', risk: 'safe', note: 'Re-downloads when needed.' },
    { path: path.join(LOCAL, 'Docker', 'wsl'), label: 'Docker WSL disk', risk: 'careful', note: 'Contains your images/volumes. Prune from Docker, not by deleting files.' },
    { path: path.join(ROAMING, 'Code', 'Cache'), label: 'VS Code cache', risk: 'safe', note: 'Rebuilds itself.' },
    { path: path.join(ROAMING, 'Code', 'CachedExtensionVSIXs'), label: 'VS Code cached extension installers', risk: 'safe', note: 'Already-installed extensions keep working.' },
    { path: 'C:\\Windows.old', label: 'Previous Windows installation', risk: 'careful', note: 'Lets you roll back a Windows upgrade. Remove via Disk Cleanup, not manually.' },
    { path: path.join(WIN, 'SoftwareDistribution', 'Download'), label: 'Windows Update downloads', risk: 'careful', note: 'Needs admin rights; clear via Disk Cleanup instead.' },
  ];
}

function dirSizeShallow(dir, budgetMs = 1500) {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length && Date.now() < deadline) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) {
        const st = fs.statSync(f, { throwIfNoEntry: false });
        if (st) {
          total += st.size;
          count++;
        }
      }
    }
  }
  return { bytes: total, files: count, complete: stack.length === 0 };
}

export async function disk_overview() {
  const drives = listDrives();
  const lines = ['## Drives', ''];
  for (const d of drives) {
    if (d.total == null) {
      lines.push(`- ${d.path} — size unavailable (removable or network drive)`);
      continue;
    }
    const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
    lines.push(`- **${d.path}** ${bar} ${pct}% full — ${humanBytes(d.used)} used, **${humanBytes(d.free)} free** of ${humanBytes(d.total)}`);
  }

  lines.push('', '## Common user folders', '');
  const folders = ['Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos', 'Music'];
  for (const f of folders) {
    const p = path.join(HOME_DIR, f);
    if (!fs.existsSync(p)) continue;
    const { bytes, files, complete } = dirSizeShallow(p, 1200);
    lines.push(`- ${f}: ${humanBytes(bytes)} across ${files.toLocaleString()} files${complete ? '' : ' (partial — large folder)'}`);
  }

  lines.push(
    '',
    `_Machine: ${os.hostname()} · ${os.platform()} ${os.release()} · ${humanBytes(os.totalmem())} RAM_`,
    '',
    'Next step: call `folder_breakdown` on a specific drive or folder to see exactly which subfolders are big, or `find_junk` for reclaimable caches.'
  );

  return { content: lines.join('\n'), data: { drives } };
}

export async function folder_breakdown({ path: target, depth = 1, top = 20, include_noise = true }, ctx) {
  const root = assertReadable(target || HOME_DIR);

  const index = await getIndex(root, {
    includeNoise: include_noise,
    onProgress: (p) => ctx?.progress?.(`Scanning ${p.dir} — ${p.files.toLocaleString()} files, ${humanBytes(p.bytes)}`),
    isCancelled: ctx?.isCancelled,
  });

  const totals = rollupDirs(index);
  const rootDepth = root.split(path.sep).filter(Boolean).length;

  const rows = Object.entries(totals)
    .filter(([p]) => {
      if (p.toLowerCase() === root.toLowerCase()) return false;
      const d = p.split(path.sep).filter(Boolean).length - rootDepth;
      return d >= 1 && d <= depth;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);

  const lines = [
    `## Breakdown of ${root}`,
    '',
    `Total: **${humanBytes(index.totalBytes)}** across ${index.fileCount.toLocaleString()} files${index.fromCache ? ' _(from cache)_' : ''}`,
    '',
    '| Size | Share | Folder |',
    '| --- | --- | --- |',
  ];
  for (const [p, size] of rows) {
    const pct = index.totalBytes ? ((size / index.totalBytes) * 100).toFixed(1) : '0';
    lines.push(`| ${humanBytes(size)} | ${pct}% | \`${p}\` |`);
  }

  // Biggest individual files matter as much as biggest folders.
  const bigFiles = [...index.files].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (bigFiles.length) {
    lines.push('', '### Largest individual files', '', '| Size | Modified | File |', '| --- | --- | --- |');
    for (const [p, size, mtime] of bigFiles) {
      lines.push(`| ${humanBytes(size)} | ${new Date(mtime).toISOString().slice(0, 10)} | \`${p}\` |`);
    }
  }

  return {
    content: lines.join('\n'),
    data: { root, totalBytes: index.totalBytes, fileCount: index.fileCount, folders: rows, largestFiles: bigFiles },
  };
}

export async function find_junk({ scope = 'user' } = {}, ctx) {
  const results = [];
  const candidates = junkCandidates();

  for (const c of candidates) {
    if (ctx?.isCancelled?.()) break;
    if (!fs.existsSync(c.path)) continue;
    ctx?.progress?.(`Measuring ${c.label}…`);
    const { bytes, files, complete } = dirSizeShallow(c.path, 1500);
    if (bytes > 1024 * 1024) results.push({ ...c, bytes, files, complete });
  }

  // Old installers sitting in Downloads are usually the easiest real win.
  const downloads = path.join(HOME_DIR, 'Downloads');
  let installers = [];
  if (fs.existsSync(downloads)) {
    ctx?.progress?.('Checking Downloads for stale installers…');
    const idx = await getIndex(downloads, { includeNoise: true, isCancelled: ctx?.isCancelled });
    const cutoff = Date.now() - 90 * 864e5;
    installers = idx.files
      .filter(([p, s, m]) => /\.(exe|msi|zip|7z|rar|iso|dmg|pkg)$/i.test(p) && m < cutoff && s > 5 * 1024 * 1024)
      .sort((a, b) => b[1] - a[1]);
  }

  results.sort((a, b) => b.bytes - a.bytes);
  const total = results.reduce((s, r) => s + r.bytes, 0);
  const installerBytes = installers.reduce((s, f) => s + f[1], 0);

  const lines = [
    '## Reclaimable space',
    '',
    `Cache/temp locations found: **${humanBytes(total)}**${installers.length ? `, plus **${humanBytes(installerBytes)}** in stale Downloads installers` : ''}.`,
    '',
    '| Size | Risk | What it is | Path |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(`| ${humanBytes(r.bytes)}${r.complete ? '' : '+'} | ${r.risk} | ${r.label} — ${r.note} | \`${r.path}\` |`);
  }

  if (installers.length) {
    lines.push(
      '',
      '### Installers in Downloads not touched in 90+ days',
      '',
      '| Size | Last modified | File |',
      '| --- | --- | --- |'
    );
    for (const [p, s, m] of installers.slice(0, 25)) {
      lines.push(`| ${humanBytes(s)} | ${new Date(m).toISOString().slice(0, 10)} | \`${p}\` |`);
    }
  }

  lines.push(
    '',
    '_"safe" = regenerates automatically. "careful" = read the note before touching it._',
    '_Nothing here has been deleted. Use `propose_changes` to stage a cleanup for the user to approve._'
  );

  return {
    content: lines.join('\n'),
    data: { locations: results, installers: installers.slice(0, 100), totalBytes: total + installerBytes },
  };
}

export async function find_files(args, ctx) {
  const {
    path: target,
    name_contains,
    name_glob,
    extensions,
    modified,
    min_size_mb,
    max_size_mb,
    limit = 100,
    sort_by = 'size',
    include_noise = false,
  } = args;

  const root = assertReadable(target || HOME_DIR);
  const index = await getIndex(root, {
    includeNoise: include_noise,
    onProgress: (p) => ctx?.progress?.(`Indexing ${p.dir} — ${p.files.toLocaleString()} files`),
    isCancelled: ctx?.isCancelled,
  });

  const { from, to } = parseDateRange(modified);
  const exts = extensions
    ? new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
    : null;
  const glob = name_glob ? globToRegExp(name_glob) : null;
  const needle = name_contains ? name_contains.toLowerCase() : null;
  const minB = min_size_mb != null ? min_size_mb * 1024 * 1024 : null;
  const maxB = max_size_mb != null ? max_size_mb * 1024 * 1024 : null;

  const matches = [];
  for (const row of index.files) {
    const [p, size, mtime] = row;
    if (exts && !exts.has(path.extname(p).toLowerCase())) continue;
    if (needle && !path.basename(p).toLowerCase().includes(needle)) continue;
    if (glob && !glob.test(path.basename(p))) continue;
    if (from != null && mtime < from) continue;
    if (to != null && mtime > to) continue;
    if (minB != null && size < minB) continue;
    if (maxB != null && size > maxB) continue;
    matches.push(row);
  }

  const sorters = {
    size: (a, b) => b[1] - a[1],
    newest: (a, b) => b[2] - a[2],
    oldest: (a, b) => a[2] - b[2],
    name: (a, b) => a[0].localeCompare(b[0]),
  };
  matches.sort(sorters[sort_by] || sorters.size);

  const shown = matches.slice(0, Math.min(limit, 500));
  const totalBytes = matches.reduce((s, m) => s + m[1], 0);

  const lines = [
    `## ${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'} in ${root}`,
    '',
    `Combined size: ${humanBytes(totalBytes)}. Searched ${index.fileCount.toLocaleString()} files${index.fromCache ? ' _(cached index)_' : ''}.`,
    '',
  ];
  if (shown.length) {
    lines.push('| Size | Modified | File |', '| --- | --- | --- |');
    for (const [p, s, m] of shown) {
      lines.push(`| ${humanBytes(s)} | ${new Date(m).toISOString().slice(0, 10)} | \`${p}\` |`);
    }
    if (matches.length > shown.length) lines.push('', `_…and ${(matches.length - shown.length).toLocaleString()} more._`);
  } else {
    lines.push('_No files matched. Try widening the filters, or set `include_noise: true` to search inside node_modules/.git._');
  }

  return {
    content: lines.join('\n'),
    data: { root, count: matches.length, totalBytes, files: shown.map(([p, s, m]) => ({ path: p, size: s, mtime: m })) },
  };
}
