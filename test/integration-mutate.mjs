// Exercises the real mutation path end to end: propose -> approve -> apply -> undo.
// This actually sends a file to the Recycle Bin and actually moves files on disk,
// so it works only inside its own scratch folder under %LOCALAPPDATA%\FileLLM.
//
// Run: node test/integration-mutate.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { propose_changes, applyPlan, undoJournal } from '../src/tools/mutate.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FileLLM', 'itest');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.stack}`);
  }
}

async function recycleBinContains(name) {
  const script = `
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(10)
$hit = $false
foreach ($item in $bin.Items()) { if ($item.Name -like '*${name}*') { $hit = $true } }
if ($hit) { 'YES' } else { 'NO' }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  return stdout.trim().endsWith('YES');
}

await fsp.rm(ROOT, { recursive: true, force: true });
await fsp.mkdir(ROOT, { recursive: true });
console.log(`\nscratch: ${ROOT}\n`);

// ---------------------------------------------------------------- recycle

await t('recycle actually sends the file to the Recycle Bin', async () => {
  const stamp = `filellm-itest-${Date.now()}`;
  const victim = path.join(ROOT, `${stamp}.txt`);
  await fsp.writeFile(victim, 'delete me');

  const proposal = await propose_changes({ summary: 'recycle test', operations: [{ action: 'recycle', path: victim, reason: 'integration test' }] }, {});
  assert.ok(proposal.data.planId, 'no plan staged');
  assert.equal(fs.existsSync(victim), true, 'file vanished at propose time');

  const result = await applyPlan(proposal.data.planId);
  assert.equal(result.okCount, 1, `apply failed: ${JSON.stringify(result.results)}`);
  assert.equal(fs.existsSync(victim), false, 'file is still on disk after recycle');

  assert.equal(await recycleBinContains(stamp), true, 'file is gone but NOT in the Recycle Bin — it was destroyed');
  console.log(`       (leftover in Recycle Bin: ${stamp}.txt — safe to purge)`);
});

// ------------------------------------------------------------------- move

await t('move relocates the file and undo puts it back', async () => {
  const from = path.join(ROOT, 'src');
  const to = path.join(ROOT, 'dest');
  await fsp.mkdir(from, { recursive: true });
  await fsp.mkdir(to, { recursive: true });
  const file = path.join(from, 'movable.txt');
  await fsp.writeFile(file, 'contents preserved');

  const proposal = await propose_changes({ summary: 'move test', operations: [{ action: 'move', path: file, destination: to, reason: 'test' }] }, {});
  const result = await applyPlan(proposal.data.planId);
  assert.equal(result.okCount, 1, JSON.stringify(result.results));

  const moved = path.join(to, 'movable.txt');
  assert.equal(fs.existsSync(moved), true, 'file did not arrive at the destination');
  assert.equal(fs.existsSync(file), false, 'file still at the source');
  assert.equal(await fsp.readFile(moved, 'utf8'), 'contents preserved');

  const undone = await undoJournal(result.journalId);
  assert.ok(undone.results.every((r) => r.ok), JSON.stringify(undone.results));
  assert.equal(fs.existsSync(file), true, 'undo did not restore the file');
  assert.equal(fs.existsSync(moved), false, 'undo left the moved copy behind');
});

// ------------------------------------------------------- collision safety

await t('a name collision does not overwrite the existing file', async () => {
  const from = path.join(ROOT, 'c-src');
  const to = path.join(ROOT, 'c-dest');
  await fsp.mkdir(from, { recursive: true });
  await fsp.mkdir(to, { recursive: true });
  await fsp.writeFile(path.join(from, 'same.txt'), 'NEW');
  await fsp.writeFile(path.join(to, 'same.txt'), 'ORIGINAL');

  const proposal = await propose_changes({ summary: 'collision', operations: [{ action: 'move', path: path.join(from, 'same.txt'), destination: to }] }, {});
  const result = await applyPlan(proposal.data.planId);
  assert.equal(result.okCount, 1, JSON.stringify(result.results));

  assert.equal(await fsp.readFile(path.join(to, 'same.txt'), 'utf8'), 'ORIGINAL', 'the existing file was overwritten!');
  assert.equal(await fsp.readFile(path.join(to, 'same (1).txt'), 'utf8'), 'NEW', 'the moved file was not renamed out of the way');
});

// ------------------------------------------------------------ rename/copy

await t('rename and copy behave, and create_folder is undoable', async () => {
  const dir = path.join(ROOT, 'rc');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, 'before.txt');
  await fsp.writeFile(f, 'x');

  const p1 = await propose_changes({ summary: 'rename', operations: [{ action: 'rename', path: f, new_name: 'after.txt' }] }, {});
  const r1 = await applyPlan(p1.data.planId);
  assert.equal(r1.okCount, 1, JSON.stringify(r1.results));
  assert.equal(fs.existsSync(path.join(dir, 'after.txt')), true);

  const newDir = path.join(dir, 'Archive');
  const p2 = await propose_changes({
    summary: 'folder + copy',
    operations: [
      { action: 'create_folder', destination: newDir },
      { action: 'copy', path: path.join(dir, 'after.txt'), destination: newDir },
    ],
  }, {});
  const r2 = await applyPlan(p2.data.planId);
  assert.equal(r2.okCount, 2, JSON.stringify(r2.results));
  assert.equal(fs.existsSync(path.join(newDir, 'after.txt')), true, 'copy did not land');
  assert.equal(fs.existsSync(path.join(dir, 'after.txt')), true, 'copy removed the original');

  const undone = await undoJournal(r2.journalId);
  assert.ok(undone.results.every((r) => r.ok), JSON.stringify(undone.results));
  assert.equal(fs.existsSync(newDir), false, 'undo did not remove the created folder');
});

// ------------------------------------------------------- rejects bad paths

await t('a rename with path separators is rejected', async () => {
  const dir = path.join(ROOT, 'esc');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, 'a.txt');
  await fsp.writeFile(f, 'x');
  const p = await propose_changes({ summary: 'escape', operations: [{ action: 'rename', path: f, new_name: '..\\..\\evil.txt' }] }, {});
  assert.equal(p.data.planId, null, 'a traversal rename was staged');
});

await t('an already-applied plan cannot be applied twice', async () => {
  const f = path.join(ROOT, 'once.txt');
  await fsp.writeFile(f, 'x');
  const p = await propose_changes({ summary: 'once', operations: [{ action: 'rename', path: f, new_name: 'once-renamed.txt' }] }, {});
  await applyPlan(p.data.planId);
  await assert.rejects(() => applyPlan(p.data.planId), /No pending plan/);
});

await fsp.rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
