// Directory walking + a compact on-disk index.
//
// The index is what makes FileLLM feel instant compared to File Explorer:
// one pass over a tree gives us every path, size and mtime, cached to disk.
// Afterwards, "all PDFs from 2018 over 5 MB" is a filter over an array, not a
// new disk crawl.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { yieldToLoop } from './util.mjs';
import { assertReadable } from './safety.mjs';

const CACHE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FileLLM', 'index');

/** Directory names that are almost never what the user meant, and are huge. */
export const NOISE_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows.old',
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
  '.gradle', '.nuget', '.cargo', '.rustup', 'obj', 'bin',
]);

const SKIP_ALWAYS = new Set(['$recycle.bin', 'system volume information', 'config.msi', '$windows.~bt', '$windows.~ws']);

/**
 * Walk `root`, calling onEntry for every file. Never follows symlinks or
 * junctions, so it cannot loop forever on a self-referential tree.
 *
 * @param {object} opts
 * @param {boolean} opts.includeNoise  descend into node_modules/.git etc.
 * @param {number}  opts.maxDepth
 * @param {(p:{dir:string,files:number,bytes:number})=>void} opts.onProgress
 * @param {()=>boolean} opts.isCancelled
 */
export async function walk(root, opts = {}) {
  const {
    includeNoise = false,
    maxDepth = 64,
    onEntry,
    onDirDone,
    onProgress,
    isCancelled = () => false,
  } = opts;

  const start = assertReadable(root);
  const stack = [{ dir: start, depth: 0 }];
  let files = 0;
  let bytes = 0;
  let sinceYield = 0;
  const errors = [];

  while (stack.length) {
    if (isCancelled()) break;
    const { dir, depth } = stack.pop();

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'ENOENT') {
        errors.push({ dir, code: err.code });
      }
      continue;
    }

    let dirBytes = 0;
    for (const ent of entries) {
      if (isCancelled()) break;
      const name = ent.name;
      const full = path.join(dir, name);

      if (ent.isSymbolicLink()) continue; // junction/symlink — skip to avoid cycles

      if (ent.isDirectory()) {
        const lower = name.toLowerCase();
        if (SKIP_ALWAYS.has(lower)) continue;
        if (!includeNoise && NOISE_DIRS.has(lower)) {
          // Still account for its size so storage reports stay honest.
          const size = await quickDirSize(full, isCancelled);
          dirBytes += size;
          bytes += size;
          onEntry?.({ path: full, size, mtime: 0, isDir: true, collapsed: true });
          continue;
        }
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (!ent.isFile()) continue;

      let st;
      try {
        st = fs.statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!st) continue;

      files++;
      bytes += st.size;
      dirBytes += st.size;
      onEntry?.({ path: full, size: st.size, mtime: st.mtimeMs, isDir: false });

      if (++sinceYield >= 4000) {
        sinceYield = 0;
        onProgress?.({ dir, files, bytes });
        await yieldToLoop();
      }
    }
    onDirDone?.({ dir, bytes: dirBytes });
  }

  onProgress?.({ dir: start, files, bytes, done: true });
  return { files, bytes, errors };
}

/** Cheap recursive byte total, used for collapsed noise dirs. */
async function quickDirSize(dir, isCancelled) {
  let total = 0;
  const stack = [dir];
  let n = 0;
  while (stack.length) {
    if (isCancelled()) break;
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
        if (st) total += st.size;
      }
    }
    if (++n % 200 === 0) await yieldToLoop();
  }
  return total;
}

// --------------------------------------------------------------- index

function cacheKey(root, includeNoise) {
  return crypto.createHash('sha1').update(`${root.toLowerCase()}|${includeNoise}`).digest('hex').slice(0, 16);
}

function cachePath(root, includeNoise) {
  return path.join(CACHE_DIR, `${cacheKey(root, includeNoise)}.json`);
}

/**
 * Build (or reuse) an index of `root`.
 * @returns {Promise<{root:string, builtAt:number, files:Array, dirs:Object, totalBytes:number, fromCache:boolean}>}
 */
export async function getIndex(root, opts = {}) {
  const { includeNoise = false, maxAgeMs = 10 * 60 * 1000, force = false, onProgress, isCancelled } = opts;
  const abs = assertReadable(root);
  const cp = cachePath(abs, includeNoise);

  if (!force) {
    try {
      const st = await fsp.stat(cp);
      if (Date.now() - st.mtimeMs < maxAgeMs) {
        const data = JSON.parse(await fsp.readFile(cp, 'utf8'));
        return { ...data, fromCache: true };
      }
    } catch {}
  }

  const files = [];
  const dirs = Object.create(null);

  const result = await walk(abs, {
    includeNoise,
    isCancelled,
    onProgress,
    onEntry: (e) => {
      if (e.isDir) {
        dirs[e.path] = (dirs[e.path] || 0) + e.size;
        return;
      }
      files.push([e.path, e.size, Math.round(e.mtime)]);
    },
    onDirDone: ({ dir, bytes }) => {
      dirs[dir] = (dirs[dir] || 0) + bytes;
    },
  });

  const index = {
    root: abs,
    builtAt: Date.now(),
    includeNoise,
    files,
    dirs,
    totalBytes: result.bytes,
    fileCount: result.files,
    errors: result.errors.slice(0, 50),
  };

  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cp, JSON.stringify(index));
  } catch {}

  return { ...index, fromCache: false };
}

/** Roll per-directory byte totals up the tree so parents include children. */
export function rollupDirs(index) {
  const totals = Object.create(null);
  for (const [p, size] of Object.entries(index.dirs)) totals[p] = size;

  const rootLower = index.root.toLowerCase();
  for (const dir of Object.keys(index.dirs)) {
    let cur = path.dirname(dir);
    const own = index.dirs[dir];
    while (cur.toLowerCase().startsWith(rootLower) && cur.length >= index.root.length) {
      totals[cur] = (totals[cur] || 0) + own;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return totals;
}

export function invalidateIndex(root) {
  for (const noise of [true, false]) {
    try {
      fs.unlinkSync(cachePath(path.resolve(root), noise));
    } catch {}
  }
}

export function clearAllIndexes() {
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {}
}

export { CACHE_DIR };
