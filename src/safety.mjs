// Path guards. Nothing in FileLLM writes, moves, or deletes without clearing this file.
//
// Two independent gates protect every mutation:
//   1. This module — refuses paths that are structurally dangerous (OS dirs, drive roots, FileLLM itself).
//   2. The UI — every mutating plan is shown to the human and executes only on explicit Approve.
// A model that goes off the rails still cannot touch anything on the deny list.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME = os.homedir();

/** Directories that are never writable, and never deletable, under any prompt. */
const DENY_PREFIXES = [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  'C:\\ProgramData\\Microsoft\\Windows',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
  'C:\\Boot',
  'C:\\EFI',
  APP_DIR,
].filter(Boolean).map((p) => path.resolve(p).toLowerCase());

/** Individual paths that must survive no matter what. */
const DENY_EXACT = [
  HOME,
  path.join(HOME, 'AppData'),
  path.join(HOME, 'AppData', 'Roaming'),
  path.join(HOME, 'AppData', 'Local'),
  os.tmpdir(),
].map((p) => path.resolve(p).toLowerCase());

/** Folder names we refuse to bulk-delete even inside allowed roots. */
const DENY_LEAF_NAMES = new Set([
  'windows', 'system32', 'syswow64', 'drivers', 'winsxs',
  'documents', 'desktop', 'downloads', 'pictures', 'videos', 'music',
  'onedrive', 'appdata', 'users', 'program files',
]);

export class SafetyError extends Error {
  constructor(message, path_) {
    super(message);
    this.name = 'SafetyError';
    this.path = path_;
  }
}

/** Absolute, normalized, no trailing slash (except drive roots), for comparison. */
export function normalize(p) {
  if (typeof p !== 'string' || !p.trim()) throw new SafetyError('Empty path', p);
  let abs = path.resolve(expandEnv(p.trim()));
  if (abs.length > 3 && abs.endsWith(path.sep)) abs = abs.slice(0, -1);
  return abs;
}

/** Expand %USERPROFILE%, ~, and $env-style tokens people paste in. */
export function expandEnv(p) {
  let out = p.replace(/^~(?=[\\/]|$)/, HOME);
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  return out;
}

function lower(p) {
  return p.toLowerCase();
}

function isUnder(child, parent) {
  const c = lower(child);
  const p = lower(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith('\\') ? p : p + '\\');
}

/**
 * True for `C:\`, `D:\`, `\\server\share` — things you must never recurse-delete.
 * normalize() keeps the trailing separator on a bare root but strips it elsewhere,
 * so compare both spellings rather than assuming one.
 */
export function isDriveRoot(p) {
  const abs = normalize(p);
  const root = path.parse(abs).root;
  if (!root) return false;
  return lower(abs) === lower(root) || lower(abs) + path.sep === lower(root);
}

/**
 * Reading is permissive — the whole point is to search anywhere the user can reach.
 * We only block the pseudo-directories that waste time or hang.
 */
export function assertReadable(p) {
  const abs = normalize(p);
  if (/^[a-z]:\\\$recycle\.bin/i.test(abs)) throw new SafetyError('Recycle Bin is not scannable directly', abs);
  if (/system volume information/i.test(abs)) throw new SafetyError('System Volume Information is not accessible', abs);
  return abs;
}

/**
 * Writing/moving/deleting is restrictive. Throws SafetyError with a plain-English
 * reason the UI shows verbatim to the user.
 */
export function assertMutable(p, { allowDirectory = true } = {}) {
  const abs = normalize(p);
  const l = lower(abs);

  if (isDriveRoot(abs)) throw new SafetyError('Refusing to modify a drive root', abs);

  for (const d of DENY_EXACT) {
    if (l === d) throw new SafetyError('Refusing to modify a protected user folder', abs);
  }

  for (const d of DENY_PREFIXES) {
    if (isUnder(abs, d)) {
      throw new SafetyError(`Refusing to modify anything inside a protected system location (${d})`, abs);
    }
  }

  if (!allowDirectory) {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (st?.isDirectory()) throw new SafetyError('Expected a file but got a directory', abs);
  }

  const leaf = path.basename(abs).toLowerCase();
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (st?.isDirectory() && DENY_LEAF_NAMES.has(leaf)) {
    throw new SafetyError(`Refusing to delete or move the well-known folder "${path.basename(abs)}"`, abs);
  }

  return abs;
}

/** Roots the scanner is willing to start from, discovered at runtime. */
export function defaultRoots() {
  const roots = [];
  const candidates = [
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Documents'),
    path.join(HOME, 'Downloads'),
    path.join(HOME, 'Pictures'),
    path.join(HOME, 'Videos'),
    path.join(HOME, 'Music'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) roots.push(c);
  return roots;
}

/** Every fixed drive Windows currently has mounted. */
export function listDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = `${String.fromCharCode(i)}:\\`;
    try {
      const st = fs.statSync(letter, { throwIfNoEntry: false });
      if (!st) continue;
      let free = null;
      let total = null;
      try {
        const s = fs.statfsSync(letter);
        total = s.blocks * s.bsize;
        free = s.bavail * s.bsize;
      } catch {}
      drives.push({ path: letter, total, free, used: total != null && free != null ? total - free : null });
    } catch {}
  }
  return drives;
}

export const HOME_DIR = HOME;
export const APP_ROOT = APP_DIR;
