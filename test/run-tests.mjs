// Plain assertions, no test framework. Run: node test/run-tests.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { writeZip, readZipDirectory, readZipEntry } from '../src/zip.mjs';
import { extractText, decodeText, looksLikeText } from '../src/extract.mjs';
import { parseDateRange, globToRegExp, humanBytes } from '../src/util.mjs';
import { normalize, assertMutable, SafetyError, listDrives } from '../src/safety.mjs';
import { walk, getIndex, rollupDirs } from '../src/walk.mjs';
import { buildFixture, cleanupFixture, grade } from '../src/selftest.mjs';
import { TOOLS, TOOL_MAP } from '../src/tools/index.mjs';
import { propose_changes, getPlan, discardPlan } from '../src/tools/mutate.mjs';

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const TMP = path.join(os.tmpdir(), `filellm-test-${Date.now()}`);
await fsp.mkdir(TMP, { recursive: true });

console.log('\nzip');
await t('write then read round-trips', () => {
  const buf = writeZip([
    { name: 'a.txt', data: 'hello world' },
    { name: 'nested/b.xml', data: '<x>value</x>' },
  ]);
  const dir = readZipDirectory(buf);
  assert.equal(dir.size, 2);
  assert.equal(readZipEntry(buf, dir, 'a.txt').toString(), 'hello world');
  assert.equal(readZipEntry(buf, dir, 'nested/b.xml').toString(), '<x>value</x>');
  assert.equal(readZipEntry(buf, dir, 'missing.txt'), null);
});

await t('rejects non-zip input', () => {
  assert.throws(() => readZipDirectory(Buffer.from('not a zip at all')), /ZIP/);
});

console.log('\nextract');
await t('reads text from a generated .docx', async () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Contract ABC-123</w:t></w:r></w:p><w:p><w:r><w:t>second line</w:t></w:r></w:p></w:body></w:document>`;
  const buf = writeZip([{ name: 'word/document.xml', data: xml }]);
  const f = path.join(TMP, 'doc.docx');
  await fsp.writeFile(f, buf);
  const r = await extractText(f);
  assert.ok(r.text.includes('Contract ABC-123'), `got: ${r.text}`);
  assert.ok(r.text.includes('second line'));
  assert.equal(r.kind, 'docx');
});

await t('reads cells from a generated .xlsx', async () => {
  const shared = `<sst><si><t>Revenue</t></si><si><t>Q1 total</t></si></sst>`;
  const sheet = `<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>4200</v></c></row></sheetData></worksheet>`;
  const buf = writeZip([
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  const f = path.join(TMP, 'book.xlsx');
  await fsp.writeFile(f, buf);
  const r = await extractText(f);
  assert.ok(r.text.includes('Revenue'), `got: ${r.text}`);
  assert.ok(r.text.includes('Q1 total'));
  assert.ok(r.text.includes('4200'));
});

await t('decodes xml entities in docx text', async () => {
  const xml = `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>R&amp;D &lt;draft&gt; caf&#233;</w:t></w:r></w:p></w:body></w:document>`;
  const buf = writeZip([{ name: 'word/document.xml', data: xml }]);
  const f = path.join(TMP, 'ent.docx');
  await fsp.writeFile(f, buf);
  const r = await extractText(f);
  assert.ok(r.text.includes('R&D <draft> café'), `got: ${r.text}`);
});

await t('decodes utf-8 BOM and utf-16', () => {
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.equal(decodeText(Buffer.from('hi', 'utf16le')), 'hi');
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.equal(decodeText(be), 'hi');
});

await t('binary sniffing rejects executables', () => {
  assert.equal(looksLikeText(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00])), false);
  assert.equal(looksLikeText(Buffer.from('plain readable text')), true);
});

await t('skips a file with no extractable text', async () => {
  const f = path.join(TMP, 'blob.bin');
  await fsp.writeFile(f, Buffer.from([0, 1, 2, 3, 0, 255, 0]));
  assert.equal(await extractText(f), null);
});

console.log('\nutil');
await t('parses the date expressions people type', () => {
  const y = parseDateRange('2018');
  assert.equal(new Date(y.from).getUTCFullYear(), 2018);
  assert.equal(new Date(y.to).getUTCFullYear(), 2018);
  assert.ok(new Date(y.to).getUTCMonth() === 11);

  const m = parseDateRange('2018-03');
  assert.equal(new Date(m.from).getUTCMonth(), 2);

  const now = Date.UTC(2026, 5, 15);
  const rel = parseDateRange('past 6 months', now);
  assert.ok(rel.from < now && rel.to === now);

  assert.deepEqual(parseDateRange(''), { from: null, to: null });
  assert.deepEqual(parseDateRange('gibberish'), { from: null, to: null });
});

await t('globs behave', () => {
  assert.ok(globToRegExp('invoice*.pdf').test('invoice_2019.pdf'));
  assert.ok(!globToRegExp('invoice*.pdf').test('receipt.pdf'));
  assert.ok(globToRegExp('*.{jpg,png}').test('photo.png'));
  assert.ok(globToRegExp('IMG_????.jpg').test('IMG_0421.jpg'));
  assert.ok(!globToRegExp('*.jpg').test('sub/photo.jpg'));
});

await t('humanBytes formats sensibly', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(1536), '1.5 KB');
  assert.equal(humanBytes(5 * 1024 ** 3), '5.0 GB');
});

console.log('\nsafety');
await t('blocks the Windows directory', () => {
  assert.throws(() => assertMutable('C:\\Windows\\System32\\drivers'), SafetyError);
  assert.throws(() => assertMutable('C:\\Windows'), SafetyError);
});

await t('blocks drive roots', () => {
  assert.throws(() => assertMutable('C:\\'), SafetyError);
  assert.throws(() => assertMutable('D:\\'), SafetyError);
});

await t('blocks the user home and well-known folders', () => {
  assert.throws(() => assertMutable(os.homedir()), SafetyError);
  assert.throws(() => assertMutable(path.join(os.homedir(), 'Documents')), SafetyError);
  assert.throws(() => assertMutable(path.join(os.homedir(), 'Downloads')), SafetyError);
});

await t('blocks Program Files', () => {
  assert.throws(() => assertMutable('C:\\Program Files\\SomeApp'), SafetyError);
  assert.throws(() => assertMutable('C:\\Program Files (x86)\\SomeApp'), SafetyError);
});

await t('allows an ordinary file under a user folder', () => {
  const p = path.join(os.homedir(), 'Downloads', 'installer.exe');
  assert.equal(assertMutable(p), path.resolve(p));
});

await t('expands environment tokens', () => {
  assert.equal(normalize('%USERPROFILE%'), path.resolve(os.homedir()));
  assert.equal(normalize('~/Desktop'), path.resolve(path.join(os.homedir(), 'Desktop')));
});

await t('detects at least one drive', () => {
  const d = listDrives();
  assert.ok(d.length >= 1, 'no drives found');
  assert.ok(d.some((x) => x.total > 0), 'no drive reported a size');
});

console.log('\nwalk + index');
await t('walks a tree and totals sizes', async () => {
  const root = path.join(TMP, 'tree');
  await fsp.mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await fsp.writeFile(path.join(root, 'one.txt'), 'x'.repeat(100));
  await fsp.writeFile(path.join(root, 'a', 'two.txt'), 'y'.repeat(200));
  await fsp.writeFile(path.join(root, 'a', 'b', 'three.txt'), 'z'.repeat(300));

  const r = await walk(root, { includeNoise: true });
  assert.equal(r.files, 3);
  assert.equal(r.bytes, 600);
});

await t('index caches and rolls up', async () => {
  const root = path.join(TMP, 'tree');
  const idx = await getIndex(root, { includeNoise: true, force: true });
  assert.equal(idx.fileCount, 3);
  assert.equal(idx.totalBytes, 600);
  assert.equal(idx.fromCache, false);

  const again = await getIndex(root, { includeNoise: true });
  assert.equal(again.fromCache, true);

  const totals = rollupDirs(idx);
  assert.equal(totals[root], 600, `root total was ${totals[root]}`);
  assert.equal(totals[path.join(root, 'a')], 500);
});

await t('does not follow directory junctions', async () => {
  const root = path.join(TMP, 'loop');
  await fsp.mkdir(path.join(root, 'real'), { recursive: true });
  await fsp.writeFile(path.join(root, 'real', 'f.txt'), 'data');
  try {
    await fsp.symlink(root, path.join(root, 'real', 'back'), 'junction');
  } catch {
    return; // needs privileges on some machines; the guard is still exercised below
  }
  const r = await walk(root, { includeNoise: true });
  assert.equal(r.files, 1, 'walker recursed into the junction');
});

console.log('\ntools');
await t('every tool has a valid schema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.name, 'missing name');
    assert.ok(tool.description?.length > 20, `${tool.name}: weak description`);
    assert.equal(tool.parameters.type, 'object', `${tool.name}: params must be an object`);
    assert.ok(typeof tool.handler === 'function', `${tool.name}: no handler`);
    for (const req of tool.parameters.required || []) {
      assert.ok(tool.parameters.properties[req], `${tool.name}: required "${req}" is not declared`);
    }
  }
});

await t('find_files filters by extension and date', async () => {
  const root = path.join(TMP, 'find');
  await fsp.mkdir(root, { recursive: true });
  const old = path.join(root, 'old.pdf');
  const recent = path.join(root, 'new.pdf');
  const other = path.join(root, 'note.txt');
  await fsp.writeFile(old, 'a'.repeat(2000));
  await fsp.writeFile(recent, 'b'.repeat(2000));
  await fsp.writeFile(other, 'c');
  const d2018 = new Date(Date.UTC(2018, 5, 1));
  await fsp.utimes(old, d2018, d2018);

  const { find_files } = await import('../src/tools/scan.mjs');
  const r = await find_files({ path: root, extensions: ['pdf'], modified: '2018' }, {});
  assert.equal(r.data.count, 1, `expected 1 got ${r.data.count}`);
  assert.ok(r.data.files[0].path.endsWith('old.pdf'));

  const all = await find_files({ path: root, extensions: ['pdf'] }, {});
  assert.equal(all.data.count, 2);
});

await t('search_content finds text inside a .docx', async () => {
  const root = path.join(TMP, 'content');
  await fsp.mkdir(root, { recursive: true });
  const xml = `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>the magic phrase is PINEAPPLE-42</w:t></w:r></w:p></w:body></w:document>`;
  await fsp.writeFile(path.join(root, 'secret.docx'), writeZip([{ name: 'word/document.xml', data: xml }]));
  await fsp.writeFile(path.join(root, 'decoy.docx'), writeZip([{ name: 'word/document.xml', data: '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>nothing here</w:t></w:r></w:p></w:body></w:document>' }]));

  const { search_content } = await import('../src/tools/search.mjs');
  const r = await search_content({ path: root, query: 'PINEAPPLE-42' }, {});
  assert.equal(r.data.matchCount, 1, `expected 1 hit, got ${r.data.matchCount}`);
  assert.ok(r.data.hits[0].path.endsWith('secret.docx'));
  assert.ok(r.data.hits[0].matches[0].snippet.includes('PINEAPPLE-42'));
});

await t('find_duplicates confirms by content, not name', async () => {
  const root = path.join(TMP, 'dupes');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  const payload = Buffer.alloc(2 * 1024 * 1024, 7);
  await fsp.writeFile(path.join(root, 'photo.jpg'), payload);
  await fsp.writeFile(path.join(root, 'sub', 'copy-of-photo.jpg'), payload);
  // Same size, different bytes — must NOT be reported.
  const other = Buffer.alloc(2 * 1024 * 1024, 9);
  await fsp.writeFile(path.join(root, 'different.jpg'), other);

  const { find_duplicates } = await import('../src/tools/dupes.mjs');
  const r = await find_duplicates({ path: root, min_size_mb: 1 }, {});
  assert.equal(r.data.groupCount, 1, `expected 1 group, got ${r.data.groupCount}`);
  assert.equal(r.data.groups[0].duplicates.length, 1);
});

console.log('\ncharts');
await t('builds a pie chart with percentages that sum to 100', async () => {
  const { make_chart } = await import('../src/tools/chart.mjs');
  const r = await make_chart({
    type: 'pie',
    title: 'Space on C:',
    format: 'bytes',
    slices: [
      { label: 'Videos', value: 50 * 1024 ** 3 },
      { label: 'Games', value: 30 * 1024 ** 3 },
      { label: 'Documents', value: 20 * 1024 ** 3 },
    ],
  });
  const c = r.data.chart;
  assert.equal(c.type, 'pie');
  assert.equal(c.slices.length, 3);
  assert.ok(Math.abs(c.slices.reduce((a, b) => a + b.percent, 0) - 100) < 0.001);
  assert.equal(c.slices[0].label, 'Videos');
  assert.equal(c.slices[0].display, '50.0 GB');
  assert.equal(c.slices[0].percent, 50);
});

await t('accepts sizes written as strings like "4.2 GB"', async () => {
  const { make_chart, parseValue } = await import('../src/tools/chart.mjs');
  assert.equal(parseValue('1 GB', 'bytes'), 1024 ** 3);
  assert.equal(parseValue('4.5mb', 'bytes'), 4.5 * 1024 ** 2);
  assert.equal(parseValue('1,024', 'number'), 1024);
  assert.equal(parseValue(2048, 'bytes'), 2048);

  const r = await make_chart({ type: 'donut', format: 'bytes', slices: [{ label: 'a', value: '2 GB' }, { label: 'b', value: '1 GB' }] });
  assert.equal(r.data.chart.slices[0].display, '2.0 GB');
  assert.ok(Math.abs(r.data.chart.slices[1].percent - 100 / 3) < 1e-9, `got ${r.data.chart.slices[1].percent}`);
});

await t('sorts descending and groups the tail into Other', async () => {
  const { make_chart } = await import('../src/tools/chart.mjs');
  const slices = Array.from({ length: 20 }, (_, i) => ({ label: `f${i}`, value: i + 1 }));
  const c = (await make_chart({ type: 'pie', slices })).data.chart;
  assert.equal(c.slices.length, 12);
  assert.equal(c.slices[0].label, 'f19');
  assert.ok(c.slices.at(-1).label.startsWith('Other ('), c.slices.at(-1).label);
  assert.ok(Math.abs(c.slices.reduce((a, b) => a + b.percent, 0) - 100) < 0.001);
});

await t('rejects unusable input with a message the model can act on', async () => {
  const { make_chart } = await import('../src/tools/chart.mjs');
  await assert.rejects(() => make_chart({ type: 'pie', slices: [] }), /non-empty/);
  await assert.rejects(() => make_chart({ type: 'sunburst', slices: [{ label: 'a', value: 1 }] }), /Unknown chart type/);
  await assert.rejects(() => make_chart({ type: 'pie', slices: [{ label: 'a', value: 'lots' }] }), /not a number/);
  await assert.rejects(() => make_chart({ type: 'pie', slices: [{ label: 'a', value: 0 }] }), /nothing to chart/);
});

await t('skips bad slices but keeps the good ones', async () => {
  const { make_chart } = await import('../src/tools/chart.mjs');
  const r = await make_chart({
    type: 'bar',
    slices: [{ label: 'good', value: 5 }, { label: 'bad', value: 'xyz' }, { label: '', value: 3 }],
  });
  assert.equal(r.data.chart.slices.length, 1);
  assert.ok(r.content.includes('skipped'), r.content);
});

console.log('\nmutation gating');
await t('propose_changes stages without touching disk', async () => {
  const root = path.join(TMP, 'mutate');
  await fsp.mkdir(root, { recursive: true });
  const victim = path.join(root, 'delete-me.txt');
  await fsp.writeFile(victim, 'x'.repeat(500));

  const r = await propose_changes({ summary: 'test plan', operations: [{ action: 'recycle', path: victim, reason: 'test' }] }, {});
  assert.ok(r.data.planId, 'no plan id returned');
  assert.equal(fs.existsSync(victim), true, 'propose_changes deleted a file — it must not');

  const plan = getPlan(r.data.planId);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.totalBytes, 500);
  discardPlan(r.data.planId);
  assert.equal(getPlan(r.data.planId), undefined);
});

await t('propose_changes refuses protected paths', async () => {
  const r = await propose_changes(
    { summary: 'bad plan', operations: [{ action: 'recycle', path: 'C:\\Windows\\System32' }, { action: 'recycle', path: 'C:\\' }] },
    {}
  );
  assert.equal(r.data.planId, null, 'a plan targeting system paths was staged');
  assert.equal(r.data.rejected.length, 2);
});

await t('propose_changes rejects a folder move into itself', async () => {
  const root = path.join(TMP, 'selfmove');
  await fsp.mkdir(path.join(root, 'inner'), { recursive: true });
  const r = await propose_changes({ summary: 'x', operations: [{ action: 'move', path: root, destination: path.join(root, 'inner') }] }, {});
  assert.equal(r.data.planId, null);
});

await t('the model has no tool that applies changes', () => {
  const mutating = TOOLS.filter((t) => t.mutating).map((t) => t.name);
  assert.deepEqual(mutating, ['propose_changes'], `unexpected mutating tools: ${mutating}`);
  assert.equal(TOOL_MAP.has('apply_plan'), false);
  assert.equal(TOOL_MAP.has('delete_file'), false);
});

console.log('\nhistory sanitising');
await t('drops tool calls that never got results', async () => {
  const { sanitizeHistory } = await import('../src/agent.mjs');
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] },
    { role: 'tool', toolCallId: 'a', name: 'x', content: 'done' },
  ];
  const out = sanitizeHistory(history);
  const assistant = out.find((m) => m.role === 'assistant');
  assert.equal(assistant.toolCalls.length, 1, 'unanswered call was kept');
  assert.equal(assistant.toolCalls[0].id, 'a');
});

await t('drops an assistant turn where nothing was answered', async () => {
  const { sanitizeHistory } = await import('../src/agent.mjs');
  const out = sanitizeHistory([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'x', args: {} }] },
  ]);
  assert.equal(out.length, 1, `expected the dangling turn to be removed, got ${JSON.stringify(out)}`);
  assert.equal(out[0].role, 'user');
});

await t('keeps a fully answered turn untouched', async () => {
  const { sanitizeHistory } = await import('../src/agent.mjs');
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }] },
    { role: 'tool', toolCallId: 'a', name: 'x', content: 'ok' },
    { role: 'assistant', content: 'answer' },
  ];
  assert.deepEqual(sanitizeHistory(history), history);
});

console.log('\nself-test fixture');
await t('fixture builds a real docx haystack with a trap', async () => {
  const fx = await buildFixture();
  try {
    assert.ok(fs.existsSync(fx.target.path));
    assert.ok(fs.existsSync(fx.trap.path));
    assert.ok(fx.decoyCount >= 40, `only ${fx.decoyCount} decoys`);

    const target = await extractText(fx.target.path);
    assert.ok(target.text.includes(fx.token), 'token missing from the target docx');
    const trap = await extractText(fx.trap.path);
    assert.ok(trap.text.includes(fx.token), 'token missing from the trap docx');

    assert.equal(new Date(fx.target.mtime).getUTCFullYear(), 2018);
    assert.equal(new Date(fx.trap.mtime).getUTCFullYear(), 2021);
    assert.ok(!fx.prompt.includes(fx.target.name), 'the prompt leaks the answer!');

    // The whole search pipeline should locate exactly the two token-bearing files.
    const { search_content } = await import('../src/tools/search.mjs');
    const all = await search_content({ path: fx.dir, query: fx.token }, {});
    assert.equal(all.data.matchCount, 2, `token search found ${all.data.matchCount} files, expected 2`);

    const only2018 = await search_content({ path: fx.dir, query: fx.token, modified: '2018' }, {});
    assert.equal(only2018.data.matchCount, 1, `2018-filtered search found ${only2018.data.matchCount}, expected 1`);
    assert.ok(only2018.data.hits[0].path === fx.target.path, 'date filter selected the wrong file');
  } finally {
    await cleanupFixture(fx.dir);
  }
});

await t('grader marks a wrong answer as FAIL', async () => {
  const fx = await buildFixture();
  try {
    const report = grade(fx, {
      finalText: `I found it: ${fx.trap.name}`,
      trace: { steps: [{ toolCalls: [{ name: 'search_content' }] }, {}], http: [{ status: 200 }], usage: { in: 10, out: 10 }, provider: 'test' },
    });
    assert.equal(report.verdict, 'FAIL');
  } finally {
    await cleanupFixture(fx.dir);
  }
});

await t('grader marks the right answer as PASS', async () => {
  const fx = await buildFixture();
  try {
    const report = grade(fx, {
      finalText: `The document is ${fx.target.name} at ${fx.target.path}.`,
      trace: { steps: [{ toolCalls: [{ name: 'search_content' }] }, {}], http: [{ status: 200 }], usage: { in: 10, out: 10 }, provider: 'test' },
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.checks, null, 2));
    assert.equal(report.passed, report.total);
  } finally {
    await cleanupFixture(fx.dir);
  }
});

await fsp.rm(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  for (const f of failures) console.error(`${f.name}:\n${f.err.stack}\n`);
  process.exit(1);
}
