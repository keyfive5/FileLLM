// Duplicate detection.
//
// Three passes, cheapest first: group by exact size, then by a hash of the
// first 64 KB, then by a full hash. Most candidates die in pass 1, so we only
// ever fully read files that are genuinely likely to be duplicates.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getIndex } from '../walk.mjs';
import { assertReadable, HOME_DIR } from '../safety.mjs';
import { humanBytes, mapLimit } from '../util.mjs';

const HEAD_BYTES = 64 * 1024;

async function hashFile(file, limit = Infinity) {
  const hash = crypto.createHash('sha1');
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(1024 * 1024, limit === Infinity ? 1024 * 1024 : limit));
    let pos = 0;
    while (pos < limit) {
      const want = Math.min(buf.length, limit - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

export async function find_duplicates(args, ctx) {
  const { path: target, min_size_mb = 1, extensions, limit = 40, include_noise = false } = args;
  const root = assertReadable(target || HOME_DIR);

  const index = await getIndex(root, {
    includeNoise: include_noise,
    onProgress: (p) => ctx?.progress?.(`Indexing ${p.dir} — ${p.files.toLocaleString()} files`),
    isCancelled: ctx?.isCancelled,
  });

  const minBytes = min_size_mb * 1024 * 1024;
  const exts = extensions?.length
    ? new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
    : null;

  // Pass 1 — identical byte counts.
  const bySize = new Map();
  for (const [p, size] of index.files) {
    if (size < minBytes) continue;
    if (exts && !exts.has(path.extname(p).toLowerCase())) continue;
    const arr = bySize.get(size);
    if (arr) arr.push(p);
    else bySize.set(size, [p]);
  }
  const sizeGroups = [...bySize.entries()].filter(([, ps]) => ps.length > 1);
  ctx?.progress?.(`${sizeGroups.length} size collisions to verify`);

  // Pass 2 — head hash.
  const headGroups = new Map();
  let done = 0;
  for (const [size, paths] of sizeGroups) {
    if (ctx?.isCancelled?.()) break;
    const hashes = await mapLimit(paths, 8, async (p) => {
      try {
        return { p, h: await hashFile(p, Math.min(HEAD_BYTES, size)) };
      } catch {
        return null;
      }
    });
    for (const item of hashes) {
      if (!item) continue;
      const key = `${size}:${item.h}`;
      const arr = headGroups.get(key);
      if (arr) arr.push(item.p);
      else headGroups.set(key, [item.p]);
    }
    if (++done % 25 === 0) ctx?.progress?.(`Fingerprinted ${done}/${sizeGroups.length} groups`);
  }

  // Pass 3 — full hash, only for files that survived both filters.
  const confirmed = [];
  const survivors = [...headGroups.entries()].filter(([, ps]) => ps.length > 1);
  done = 0;
  for (const [key, paths] of survivors) {
    if (ctx?.isCancelled?.()) break;
    const size = Number(key.split(':')[0]);
    const full = new Map();
    const hashes = await mapLimit(paths, 6, async (p) => {
      try {
        return { p, h: size <= HEAD_BYTES ? key.split(':')[1] : await hashFile(p) };
      } catch {
        return null;
      }
    });
    for (const item of hashes) {
      if (!item) continue;
      const arr = full.get(item.h);
      if (arr) arr.push(item.p);
      else full.set(item.h, [item.p]);
    }
    for (const [h, ps] of full) {
      if (ps.length > 1) {
        // Keep the oldest copy by default — usually the original.
        const withTimes = ps
          .map((p) => {
            const st = fs.statSync(p, { throwIfNoEntry: false });
            return { path: p, mtime: st ? st.mtimeMs : 0 };
          })
          .sort((a, b) => a.mtime - b.mtime);
        confirmed.push({ hash: h.slice(0, 12), size, keep: withTimes[0], duplicates: withTimes.slice(1), wasted: size * (ps.length - 1) });
      }
    }
    if (++done % 25 === 0) ctx?.progress?.(`Verified ${done}/${survivors.length} groups`);
  }

  confirmed.sort((a, b) => b.wasted - a.wasted);
  const shown = confirmed.slice(0, limit);
  const totalWasted = confirmed.reduce((s, g) => s + g.wasted, 0);

  const lines = [
    `## Duplicate files in ${root}`,
    '',
    `**${confirmed.length} group(s)** of byte-identical files, wasting **${humanBytes(totalWasted)}**.`,
    `Verified by SHA-1 over full file contents — these are exact duplicates, not just same-name or same-size.`,
    '',
  ];

  for (const g of shown) {
    lines.push(
      `### ${humanBytes(g.size)} each · ${g.duplicates.length + 1} copies · ${humanBytes(g.wasted)} reclaimable`,
      `- **keep** \`${g.keep.path}\` _(oldest, ${new Date(g.keep.mtime).toISOString().slice(0, 10)})_`
    );
    for (const d of g.duplicates) lines.push(`- dupe \`${d.path}\` _(${new Date(d.mtime).toISOString().slice(0, 10)})_`);
    lines.push('');
  }
  if (confirmed.length > shown.length) lines.push(`_…and ${confirmed.length - shown.length} more groups._`, '');

  if (confirmed.length) {
    lines.push('_To act on this, call `propose_changes` with `recycle` operations for the duplicate paths only — never the "keep" path._');
  }

  return {
    content: lines.join('\n'),
    data: {
      root,
      groups: shown.map((g) => ({ size: g.size, wasted: g.wasted, keep: g.keep.path, duplicates: g.duplicates.map((d) => d.path) })),
      totalWasted,
      groupCount: confirmed.length,
    },
  };
}
