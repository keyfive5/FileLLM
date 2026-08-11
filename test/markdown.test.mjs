// The renderer lives in the browser bundle, so load it by evaluating the module
// source with a stub DOM. Cheaper than a headless browser and catches the
// regressions that matter: escaping, fences, tables.
//
// Run: node test/markdown.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'app.js'), 'utf8');

// Pull the two pure functions out of the module without executing the rest of it.
const start = src.indexOf('function escapeHtml(');
const end = src.indexOf('/** Turn <code> spans');
assert.ok(start > 0 && end > start, 'could not locate the markdown section of app.js');
const { markdown, escapeHtml } = await import(
  `data:text/javascript,${encodeURIComponent(`${src.slice(start, end)}\nexport { markdown, escapeHtml };`)}`
);

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

t('escapes html so file contents cannot inject markup', () => {
  const out = markdown('a <script>alert(1)</script> b');
  assert.ok(!out.includes('<script>'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

t('renders fenced code blocks as <pre><code>', () => {
  const out = markdown('before\n\n```\nline one\nline two\n```\n\nafter');
  assert.ok(out.includes('<pre><code>line one\nline two</code></pre>'), out);
  assert.ok(!out.includes('FENCE'), `placeholder leaked: ${out}`);
});

t('a fence containing html is escaped, not executed', () => {
  const out = markdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(out.includes('&lt;img'), out);
  assert.ok(!out.includes('<img'), out);
});

t('renders tables', () => {
  const out = markdown('| Size | File |\n| --- | --- |\n| 4 GB | `C:\\a.iso` |');
  assert.ok(out.includes('<table>'), out);
  assert.ok(out.includes('<th>Size</th>'), out);
  assert.ok(out.includes('<code>C:\\a.iso</code>'), out);
});

t('renders headings, lists, quotes and rules', () => {
  assert.ok(markdown('## Title').includes('<h3>Title</h3>'));
  assert.ok(markdown('- one\n- two').includes('<li>one</li>'));
  assert.ok(markdown('1. one\n2. two').includes('<ol>'));
  assert.ok(markdown('> quoted').includes('<blockquote>'), markdown('> quoted'));
  assert.ok(markdown('---').includes('<hr>'));
});

t('search-result snippets render as blockquotes, not literal &gt;', () => {
  // This is the exact shape search_content emits.
  const out = markdown('### `C:\\docs\\a.docx`\n\n> …the reference code ZPHR-1234 was tabled…\n');
  assert.ok(out.includes('<blockquote>'), out);
  assert.ok(!out.includes('<p>&gt;'), `quote leaked as literal text: ${out}`);
});

t('inline emphasis and code', () => {
  const out = markdown('**bold** and *italic* and `code`');
  assert.ok(out.includes('<strong>bold</strong>'), out);
  assert.ok(out.includes('<em>italic</em>'), out);
  assert.ok(out.includes('<code>code</code>'), out);
});

t('windows paths with backslashes survive intact', () => {
  const out = markdown('File: `C:\\Users\\Me\\Documents\\report_2018.docx`');
  assert.ok(out.includes('C:\\Users\\Me\\Documents\\report_2018.docx'), out);
});

t('underscores inside a path do not become emphasis', () => {
  const out = markdown('`meeting_minutes_q3.docx`');
  assert.ok(!out.includes('<em>'), out);
  assert.ok(out.includes('meeting_minutes_q3.docx'), out);
});

t('does not crash on empty or odd input', () => {
  assert.equal(typeof markdown(''), 'string');
  assert.equal(typeof markdown('\n\n\n'), 'string');
  assert.equal(typeof markdown('```unclosed'), 'string');
  assert.equal(typeof markdown('| broken | table'), 'string');
});

// ------------------------------------------------------- chart rendering

const chartStart = src.indexOf('const CHART_COLORS');
const chartEnd = src.indexOf('function renderChartCard');
assert.ok(chartStart > 0 && chartEnd > chartStart, 'could not locate the chart section of app.js');
const chartMod = await import(
  `data:text/javascript,${encodeURIComponent(
    `${src.slice(start, end)}\n${src.slice(chartStart, chartEnd)}\n` +
      `function fmtBytes(n){return n+' B';}\n` +
      `export { renderPie, renderBar, arcPath, polar, CHART_COLORS };`
  )}`
);

t('pie slices produce valid arc paths', () => {
  const chart = {
    type: 'pie',
    title: 'x',
    format: 'bytes',
    slices: [
      { label: 'a', value: 50, display: '50 B', percent: 50 },
      { label: 'b', value: 30, display: '30 B', percent: 30 },
      { label: 'c', value: 20, display: '20 B', percent: 20 },
    ],
  };
  const svg = chartMod.renderPie(chart);
  assert.equal((svg.match(/<path /g) || []).length, 3, svg);
  assert.ok(svg.includes('<svg'), svg);
  assert.ok(!/NaN|undefined/.test(svg), `bad numbers in path: ${svg}`);
  assert.equal((svg.match(/<title>/g) || []).length, 3);
});

t('a single 100% slice draws a full circle instead of collapsing', () => {
  // With one slice, start and end angles coincide; a naive arc renders nothing.
  const chart = { type: 'pie', title: 'x', format: 'number', slices: [{ label: 'only', value: 9, display: '9', percent: 100 }] };
  const svg = chartMod.renderPie(chart);
  assert.ok(!/NaN/.test(svg), svg);
  const d = /d="([^"]+)"/.exec(svg)[1];
  assert.ok((d.match(/A /g) || []).length >= 2, `expected two arcs for a full circle, got: ${d}`);
});

t('a donut leaves a hole', () => {
  const chart = { type: 'donut', title: 'x', format: 'number', slices: [{ label: 'a', value: 1, display: '1', percent: 100 }] };
  const svg = chartMod.renderPie(chart);
  assert.ok(!/NaN/.test(svg), svg);
  assert.ok(svg.includes('total'), 'donut should show a centre total');
});

t('bar chart scales to the largest value and escapes labels', () => {
  const chart = {
    type: 'bar',
    title: 'x',
    format: 'bytes',
    slices: [
      { label: '<script>', value: 100, display: '100 B', percent: 80 },
      { label: 'small', value: 10, display: '10 B', percent: 20 },
    ],
  };
  const svg = chartMod.renderBar(chart);
  assert.equal((svg.match(/<rect /g) || []).length, 2, svg);
  assert.ok(!svg.includes('<script>'), `label was not escaped: ${svg}`);
  assert.ok(svg.includes('&lt;script&gt;'), svg);
  assert.ok(!/NaN|undefined/.test(svg), svg);

  const widths = [...svg.matchAll(/<rect [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths[0] > widths[1], `bars not scaled: ${widths}`);
});

t('a zero-value bar still renders a visible sliver', () => {
  const chart = { type: 'bar', title: 'x', format: 'number', slices: [{ label: 'big', value: 100, display: '100', percent: 100 }, { label: 'zero', value: 0, display: '0', percent: 0 }] };
  const svg = chartMod.renderBar(chart);
  const widths = [...svg.matchAll(/<rect [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths[1] >= 2, `zero bar collapsed to ${widths[1]}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
