// Changing files.
//
// Design rule: the model can only ever PROPOSE. `propose_changes` builds and
// validates a plan and hands it back; nothing on disk moves. The plan executes
// only when the human clicks Approve in the UI, which calls `applyPlan` — a
// function the model has no tool for. Every applied plan writes an undo journal.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertMutable, assertReadable, SafetyError } from '../safety.mjs';
import { humanBytes, shortId } from '../util.mjs';
import { invalidateIndex } from '../walk.mjs';

const execFileAsync = promisify(execFile);
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FileLLM');
const JOURNAL_DIR = path.join(STATE_DIR, 'undo');

/** Plans awaiting human approval, keyed by id. Never persisted — approval is per-session. */
const pendingPlans = new Map();

const VALID_ACTIONS = new Set(['recycle', 'move', 'rename', 'copy', 'create_folder']);

function sizeOf(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return { bytes: 0, files: 0, exists: false, isDir: false };
  if (st.isFile()) return { bytes: st.size, files: 1, exists: true, isDir: false };

  let bytes = 0;
  let files = 0;
  const stack = [p];
  while (stack.length) {
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
        const s = fs.statSync(f, { throwIfNoEntry: false });
        if (s) {
          bytes += s.size;
          files++;
        }
      }
    }
  }
  return { bytes, files, exists: true, isDir: true };
}

/**
 * Model-callable. Validates every operation and returns a plan for human review.
 * Touches nothing.
 */
export async function propose_changes({ summary, operations }, ctx) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('propose_changes requires a non-empty `operations` array.');
  }
  if (operations.length > 5000) {
    throw new Error('Refusing a plan with more than 5000 operations. Narrow it down.');
  }

  const validated = [];
  const rejected = [];
  let totalBytes = 0;
  let totalFiles = 0;

  for (const op of operations) {
    const action = String(op.action || '').toLowerCase();
    try {
      if (!VALID_ACTIONS.has(action)) throw new SafetyError(`Unknown action "${op.action}"`, op.path);

      if (action === 'create_folder') {
        const dest = assertMutable(op.destination || op.path);
        validated.push({ action, destination: dest, bytes: 0, files: 0 });
        continue;
      }

      const src = assertMutable(op.path);
      const info = sizeOf(src);
      if (!info.exists) throw new SafetyError('Path no longer exists', src);

      const entry = { action, path: src, bytes: info.bytes, files: info.files, isDir: info.isDir, reason: op.reason || '' };

      if (action === 'move' || action === 'copy') {
        if (!op.destination) throw new SafetyError('move/copy requires a `destination`', src);
        const dest = assertMutable(op.destination);
        if (dest.toLowerCase().startsWith(src.toLowerCase() + path.sep)) {
          throw new SafetyError('Cannot move a folder into itself', src);
        }
        entry.destination = dest;
      }
      if (action === 'rename') {
        if (!op.new_name) throw new SafetyError('rename requires a `new_name`', src);
        if (/[\\/:*?"<>|]/.test(op.new_name)) throw new SafetyError(`Invalid characters in new name "${op.new_name}"`, src);
        entry.destination = path.join(path.dirname(src), op.new_name);
      }

      validated.push(entry);
      totalBytes += info.bytes;
      totalFiles += info.files;
    } catch (err) {
      rejected.push({ op, reason: err.message });
    }
  }

  if (!validated.length) {
    return {
      content: [
        '## Plan rejected — nothing survived the safety check',
        '',
        ...rejected.map((r) => `- \`${r.op.path || r.op.destination}\` — ${r.reason}`),
      ].join('\n'),
      data: { planId: null, rejected },
    };
  }

  const planId = shortId('plan_');
  const plan = { id: planId, summary: summary || 'File changes', operations: validated, rejected, totalBytes, totalFiles, createdAt: Date.now() };
  pendingPlans.set(planId, plan);
  ctx?.emit?.('plan', plan);

  const byAction = {};
  for (const o of validated) byAction[o.action] = (byAction[o.action] || 0) + 1;

  const lines = [
    `## Proposed: ${plan.summary}`,
    '',
    `**${validated.length} operation(s)** — ${Object.entries(byAction).map(([a, n]) => `${n} ${a}`).join(', ')}`,
    `Affects ${totalFiles.toLocaleString()} file(s), **${humanBytes(totalBytes)}**.`,
    '',
    '| Action | Size | Target | Destination |',
    '| --- | --- | --- | --- |',
  ];
  for (const o of validated.slice(0, 60)) {
    lines.push(`| ${o.action} | ${humanBytes(o.bytes)} | \`${o.path || ''}\` | \`${o.destination || ''}\` |`);
  }
  if (validated.length > 60) lines.push(`| … | | _${validated.length - 60} more_ | |`);

  if (rejected.length) {
    lines.push('', '### Blocked by the safety layer', '');
    for (const r of rejected) lines.push(`- \`${r.op.path || r.op.destination}\` — ${r.reason}`);
  }

  lines.push(
    '',
    '**Nothing has been changed yet.** This plan is now waiting in the approval panel; the user must click Approve for it to run.',
    'Deletions go to the Recycle Bin, and moves/renames are recorded so they can be undone.',
    '',
    'Tell the user what you are proposing and why, then stop and wait — do not call this tool again for the same plan.'
  );

  return { content: lines.join('\n'), data: { planId, summary: plan.summary, operations: validated.length, totalBytes, rejected } };
}

export function getPlan(id) {
  return pendingPlans.get(id);
}

export function listPlans() {
  return [...pendingPlans.values()];
}

export function discardPlan(id) {
  return pendingPlans.delete(id);
}

/**
 * Executes an approved plan. NOT exposed as a tool — only the HTTP approve
 * endpoint can reach this, and only with a planId the human clicked on.
 */
export async function applyPlan(id, { onProgress } = {}) {
  const plan = pendingPlans.get(id);
  if (!plan) throw new Error(`No pending plan with id ${id} (it may already have been applied).`);

  const journal = { id: shortId('undo_'), planId: id, summary: plan.summary, at: Date.now(), entries: [] };
  const results = [];
  const recycleBatch = [];

  for (const op of plan.operations) {
    if (op.action === 'recycle') {
      recycleBatch.push(op.path);
      continue;
    }
    try {
      // Re-validate at execution time: the tree may have changed since proposal.
      if (op.path) assertMutable(op.path);
      if (op.destination) assertMutable(op.destination);

      if (op.action === 'create_folder') {
        await fsp.mkdir(op.destination, { recursive: true });
        journal.entries.push({ action: 'create_folder', created: op.destination });
        results.push({ ok: true, op, note: 'created' });
      } else if (op.action === 'move' || op.action === 'rename') {
        const dest = await uniqueDestination(op.action === 'move' ? path.join(op.destination, path.basename(op.path)) : op.destination);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await moveAcrossVolumes(op.path, dest);
        journal.entries.push({ action: 'move', from: op.path, to: dest });
        results.push({ ok: true, op, note: `→ ${dest}` });
      } else if (op.action === 'copy') {
        const dest = await uniqueDestination(path.join(op.destination, path.basename(op.path)));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.cp(op.path, dest, { recursive: true, errorOnExist: false });
        journal.entries.push({ action: 'copy', created: dest });
        results.push({ ok: true, op, note: `→ ${dest}` });
      }
      invalidateIndex(path.dirname(op.path || op.destination));
      onProgress?.({ done: results.length, total: plan.operations.length });
    } catch (err) {
      results.push({ ok: false, op, error: err.message });
    }
  }

  if (recycleBatch.length) {
    onProgress?.({ done: results.length, total: plan.operations.length, note: `Sending ${recycleBatch.length} item(s) to the Recycle Bin` });
    const outcome = await sendToRecycleBin(recycleBatch);
    for (const p of recycleBatch) {
      const failed = outcome.failed.find((f) => f.path.toLowerCase() === p.toLowerCase());
      if (failed) results.push({ ok: false, op: { action: 'recycle', path: p }, error: failed.error });
      else {
        results.push({ ok: true, op: { action: 'recycle', path: p }, note: 'sent to Recycle Bin' });
        journal.entries.push({ action: 'recycle', path: p });
      }
      invalidateIndex(path.dirname(p));
    }
  }

  pendingPlans.delete(id);

  try {
    await fsp.mkdir(JOURNAL_DIR, { recursive: true });
    await fsp.writeFile(path.join(JOURNAL_DIR, `${journal.id}.json`), JSON.stringify(journal, null, 2));
  } catch {}

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const reclaimed = results.filter((r) => r.ok && r.op.action === 'recycle').reduce((s, r) => s + (r.op.bytes || 0), 0);

  return { journalId: journal.id, results, okCount, failCount, reclaimed, undoable: journal.entries.length > 0 };
}

/** Reverse an applied plan: move things back, restore folders. Recycled items must come back from the bin manually. */
export async function undoJournal(journalId) {
  const file = path.join(JOURNAL_DIR, `${journalId}.json`);
  const journal = JSON.parse(await fsp.readFile(file, 'utf8'));
  const results = [];

  for (const e of [...journal.entries].reverse()) {
    try {
      if (e.action === 'move') {
        await fsp.mkdir(path.dirname(e.from), { recursive: true });
        await moveAcrossVolumes(e.to, e.from);
        results.push({ ok: true, note: `restored ${e.from}` });
      } else if (e.action === 'copy' || e.action === 'create_folder') {
        await fsp.rm(e.created, { recursive: true, force: true });
        results.push({ ok: true, note: `removed ${e.created}` });
      } else if (e.action === 'recycle') {
        results.push({ ok: false, note: `${e.path} is in the Recycle Bin — restore it from there (right-click → Restore)` });
      }
    } catch (err) {
      results.push({ ok: false, note: err.message });
    }
  }
  return { results };
}

export async function listJournals() {
  try {
    const files = await fsp.readdir(JOURNAL_DIR);
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(JOURNAL_DIR, f), 'utf8'));
        out.push({ id: j.id, summary: j.summary, at: j.at, count: j.entries.length });
      } catch {}
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 25);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- helpers

/** Never silently clobber: foo.txt -> foo (1).txt */
async function uniqueDestination(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name for ${dest}`);
}

/** fs.rename fails with EXDEV across drives; fall back to copy+delete. */
async function moveAcrossVolumes(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true, errorOnExist: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/**
 * Delete via the Recycle Bin, not permanently. Uses the same VB FileSystem API
 * Explorer itself calls, so items land in the bin with restore metadata intact.
 */
async function sendToRecycleBin(paths) {
  const failed = [];
  if (!paths.length) return { failed };

  // Hand the list over as a UTF-8 file rather than argv or stdin: paths routinely
  // contain spaces, quotes, brackets and non-ASCII, and a batch can be thousands long.
  await fsp.mkdir(STATE_DIR, { recursive: true });
  const listFile = path.join(STATE_DIR, `recycle_${shortId()}.txt`);
  const outFile = path.join(STATE_DIR, `recycle_${shortId()}.json`);
  await fsp.writeFile(listFile, paths.join('\n'), 'utf8');

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$results = New-Object System.Collections.ArrayList
foreach ($p in [System.IO.File]::ReadAllLines('${psQuote(listFile)}', [System.Text.Encoding]::UTF8)) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  try {
    if ([System.IO.Directory]::Exists($p)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    [void]$results.Add([pscustomobject]@{ path = $p; ok = $true; error = '' })
  } catch {
    [void]$results.Add([pscustomobject]@{ path = $p; ok = $false; error = $_.Exception.Message })
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3 | Set-Content -LiteralPath '${psQuote(outFile)}' -Encoding UTF8
`;

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    );
    const raw = await fsp.readFile(outFile, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '').trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set();
    for (const r of rows) {
      seen.add(String(r.path).toLowerCase());
      if (!r.ok) failed.push({ path: r.path, error: r.error });
    }
    // Anything PowerShell never reported on did not get deleted.
    for (const p of paths) {
      if (!seen.has(p.toLowerCase())) failed.push({ path: p, error: 'No result returned for this path' });
    }
  } catch (err) {
    for (const p of paths) failed.push({ path: p, error: `Recycle Bin call failed: ${err.message}` });
  } finally {
    await fsp.rm(listFile, { force: true }).catch(() => {});
    await fsp.rm(outFile, { force: true }).catch(() => {});
  }
  return { failed };
}

/** Escape a path for embedding in a PowerShell single-quoted string. */
function psQuote(p) {
  return p.replace(/'/g, "''");
}

export { STATE_DIR };
