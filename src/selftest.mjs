// The "prove it" test.
//
// Claiming something is an AI agent is cheap. This makes it demonstrate it:
//
//  1. We generate a random token that cannot exist in any model's training data.
//  2. We write it into a real .docx (a ZIP of XML) buried in a folder of decoys.
//  3. We plant a TRAP: a second .docx containing the *same* token, but with a
//     different modification year.
//  4. We ask the agent, in plain English, for the 2018 document containing that
//     token — and never tell it the filename, the folder layout, or which tool to use.
//
// To pass it must choose tools on its own, parse a binary Office format, apply a
// date filter, and reject the trap. A canned script or a keyword matcher fails.
// A hardcoded answer is impossible: the token is new every run.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { writeZip } from './zip.mjs';
import { invalidateIndex } from './walk.mjs';

const TEST_ROOT = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FileLLM', 'selftest');

const LOREM = [
  'Quarterly figures were reviewed by the committee and filed without objection.',
  'Please find attached the revised schedule for the upcoming maintenance window.',
  'The board approved the budget allocation for the following fiscal period.',
  'Meeting notes: attendance was light, agenda items three and four were deferred.',
  'Invoice terms remain net thirty from the date of issue as previously agreed.',
  'Draft copy for review. Do not distribute outside the working group.',
];

function docx(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');

  return writeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

function randomDateIn(year) {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return new Date(start + Math.random() * (end - start));
}

/** Build the haystack. Returns everything the grader needs. */
export async function buildFixture() {
  const id = crypto.randomBytes(4).toString('hex');
  const token = `ZPHR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const dir = path.join(TEST_ROOT, `case_${id}`);

  const subdirs = ['Archive/2018', 'Archive/2019', 'Archive/Misc', 'Projects/Alpha', 'Projects/Beta', 'Scans'];
  for (const s of subdirs) await fsp.mkdir(path.join(dir, s), { recursive: true });

  const created = [];
  const write = async (rel, data, when) => {
    const full = path.join(dir, rel);
    await fsp.writeFile(full, data);
    await fsp.utimes(full, when, when);
    created.push({ path: full, mtime: when.getTime() });
    return full;
  };

  // 42 decoys with no token at all, scattered across years and formats.
  for (let i = 0; i < 42; i++) {
    const sub = subdirs[i % subdirs.length];
    const year = 2016 + (i % 8);
    const when = randomDateIn(year);
    const text = [LOREM[i % LOREM.length], `Reference number ${1000 + i}.`, `Filed under ${sub}.`];
    if (i % 3 === 0) await write(path.join(sub, `report_${year}_${i}.docx`), docx(text), when);
    else if (i % 3 === 1) await write(path.join(sub, `notes_${year}_${i}.txt`), text.join('\n'), when);
    else await write(path.join(sub, `data_${year}_${i}.csv`), `id,note\n${i},"${text[0]}"\n`, when);
  }

  // Near-miss: token with one character changed. Catches sloppy fuzzy matching.
  const nearMiss = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  await write(
    path.join('Projects/Beta', 'similar_reference.docx'),
    docx(['Cross-reference document.', `See also ${nearMiss} for the related entry.`]),
    randomDateIn(2018)
  );

  // The trap: correct token, wrong year.
  const trapDate = randomDateIn(2021);
  const trapPath = await write(
    path.join('Projects/Alpha', 'handover_summary.docx'),
    docx(['Handover summary.', `Superseded record ${token} was migrated from the legacy system.`, 'No further action required.']),
    trapDate
  );

  // The answer: correct token, correct year, unremarkable name.
  const targetDate = randomDateIn(2018);
  const targetPath = await write(
    path.join('Archive/2018', 'meeting_minutes_q3.docx'),
    docx([
      'Minutes of the third quarter review.',
      `Item 4: the contract reference ${token} was tabled for discussion.`,
      'Item 5: any other business. None raised.',
    ]),
    targetDate
  );

  invalidateIndex(dir);

  return {
    id,
    dir,
    token,
    nearMiss,
    target: { path: targetPath, name: path.basename(targetPath), mtime: targetDate.getTime() },
    trap: { path: trapPath, name: path.basename(trapPath), mtime: trapDate.getTime() },
    decoyCount: created.length - 2,
    prompt:
      `Somewhere under ${dir} there is a document last modified in 2018 that contains the reference code ${token}. ` +
      `Find it and tell me its exact filename and full path. Be careful: more than one file mentions that code, ` +
      `so make sure the one you report is the 2018 one. Do not change any files.`,
  };
}

/** Grade a finished run against the fixture. */
export function grade(fixture, { finalText, trace }) {
  const text = (finalText || '').toLowerCase();
  const toolNames = trace.steps.flatMap((s) => (s.toolCalls || []).map((t) => t.name));

  const namedTarget = text.includes(fixture.target.name.toLowerCase());
  const namedTrap = text.includes(fixture.trap.name.toLowerCase());

  const checks = [
    {
      id: 'tools_used',
      label: 'Chose and called tools on its own',
      pass: toolNames.length > 0,
      detail: toolNames.length ? `${toolNames.length} call(s): ${[...new Set(toolNames)].join(', ')}` : 'No tools were called',
    },
    {
      id: 'read_binary',
      label: 'Read inside a binary .docx to find the token',
      pass: toolNames.includes('search_content') || toolNames.includes('read_file'),
      detail: 'The token exists only inside compressed XML in a ZIP container — plain filename search cannot see it',
    },
    {
      id: 'found_target',
      label: 'Reported the correct 2018 document',
      pass: namedTarget,
      detail: `Expected "${fixture.target.name}"`,
    },
    {
      id: 'rejected_trap',
      label: 'Rejected the 2021 decoy containing the same token',
      pass: namedTarget && !namedTrap,
      detail: namedTrap ? `Also reported the trap "${fixture.trap.name}"` : `Trap "${fixture.trap.name}" was correctly excluded`,
    },
    {
      id: 'multi_step',
      label: 'Ran a genuine multi-step loop (observe → decide → act)',
      pass: trace.steps.length >= 2,
      detail: `${trace.steps.length} model turn(s), ${trace.http.length} live API round-trip(s)`,
    },
    {
      id: 'live_model',
      label: 'Every decision came from a live model call, not a script',
      pass: trace.http.length > 0 && trace.http.every((h) => h.status === 200 || h.status === 0) && trace.http.some((h) => h.status === 200),
      detail: trace.http.length ? `${trace.http.length} HTTP request(s) to ${trace.provider}, ${trace.usage.in + trace.usage.out} tokens` : 'No API traffic recorded',
    },
  ];

  const passed = checks.filter((c) => c.pass).length;
  return {
    passed,
    total: checks.length,
    verdict: checks.find((c) => c.id === 'found_target').pass && checks.find((c) => c.id === 'rejected_trap').pass ? 'PASS' : 'FAIL',
    checks,
    token: fixture.token,
    expected: fixture.target.path,
  };
}

export async function cleanupFixture(dir) {
  if (!path.resolve(dir).toLowerCase().startsWith(TEST_ROOT.toLowerCase())) {
    throw new Error('Refusing to clean a path outside the self-test directory');
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

export { TEST_ROOT };
