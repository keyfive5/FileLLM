// Charting.
//
// The tool does not draw anything — it validates and normalises a chart spec,
// and the UI renders it as inline SVG. Keeping the drawing in the browser means
// no image encoding, no temp files, and the chart scales with the window.
//
// The model is expected to gather real numbers with the other tools first and
// pass them in; nothing here invents data.

import { humanBytes } from '../util.mjs';

const MAX_SLICES = 12;
const TYPES = new Set(['pie', 'donut', 'bar']);
const FORMATS = new Set(['bytes', 'number', 'percent']);

const UNIT_MULTIPLIERS = {
  b: 1, byte: 1, bytes: 1,
  kb: 1024, k: 1024,
  mb: 1024 ** 2, m: 1024 ** 2,
  gb: 1024 ** 3, g: 1024 ** 3,
  tb: 1024 ** 4, t: 1024 ** 4,
  pb: 1024 ** 5,
};

/**
 * Models are inconsistent about types: a size may arrive as 4294967296, "4 GB",
 * or "4.2gb". Accept all three rather than making the model guess our format.
 */
export function parseValue(raw, format) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return NaN;

  const s = raw.trim().replace(/,/g, '');
  const plain = Number(s);
  if (Number.isFinite(plain)) return plain;

  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(s);
  if (!m) return NaN;

  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (format === 'bytes') {
    const mult = UNIT_MULTIPLIERS[unit];
    return mult ? n * mult : NaN;
  }
  if (unit === '%' || unit === 'pct' || unit === 'percent') return n;
  return n;
}

export function formatValue(n, format) {
  if (format === 'bytes') return humanBytes(n);
  if (format === 'percent') return `${n.toFixed(1)}%`;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100);
}

export async function make_chart(args) {
  const { type = 'pie', title, slices, format = 'number', note } = args;

  if (!TYPES.has(type)) throw new Error(`Unknown chart type "${type}". Use one of: ${[...TYPES].join(', ')}.`);
  if (!FORMATS.has(format)) throw new Error(`Unknown format "${format}". Use one of: ${[...FORMATS].join(', ')}.`);
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error('make_chart needs a non-empty `slices` array of {label, value}. Gather the real numbers with another tool first.');
  }

  const cleaned = [];
  const dropped = [];
  for (const s of slices) {
    const label = String(s?.label ?? '').trim();
    const value = parseValue(s?.value, format);
    if (!label) {
      dropped.push({ slice: s, why: 'missing label' });
      continue;
    }
    if (!Number.isFinite(value)) {
      dropped.push({ slice: s, why: `value "${s?.value}" is not a number` });
      continue;
    }
    if (value < 0) {
      dropped.push({ slice: s, why: 'negative values cannot be charted' });
      continue;
    }
    cleaned.push({ label, value });
  }

  if (!cleaned.length) {
    throw new Error(
      `None of the ${slices.length} slice(s) were usable: ${dropped.map((d) => d.why).join('; ')}. ` +
        'Pass numeric values, e.g. {"label":"Downloads","value":4294967296} with format "bytes".'
    );
  }

  const total = cleaned.reduce((a, b) => a + b.value, 0);
  if (total <= 0) throw new Error('All slice values are zero, so there is nothing to chart.');

  cleaned.sort((a, b) => b.value - a.value);

  // Too many slivers is unreadable; roll the tail into one "Other" slice.
  let final = cleaned;
  if (cleaned.length > MAX_SLICES) {
    const head = cleaned.slice(0, MAX_SLICES - 1);
    const tail = cleaned.slice(MAX_SLICES - 1);
    head.push({ label: `Other (${tail.length} more)`, value: tail.reduce((a, b) => a + b.value, 0) });
    final = head;
  }

  const chart = {
    type,
    title: title || 'Chart',
    format,
    total,
    note: note || null,
    slices: final.map((s) => ({
      label: s.label,
      value: s.value,
      display: formatValue(s.value, format),
      percent: (s.value / total) * 100,
    })),
  };

  const lines = [
    `Rendered a ${type} chart: **${chart.title}**`,
    '',
    `${chart.slices.length} segment(s), total ${formatValue(total, format)}.`,
    '',
    '| Segment | Value | Share |',
    '| --- | --- | --- |',
    ...chart.slices.map((s) => `| ${s.label} | ${s.display} | ${s.percent.toFixed(1)}% |`),
  ];
  if (dropped.length) {
    lines.push('', `_${dropped.length} slice(s) were skipped: ${dropped.map((d) => d.why).join('; ')}._`);
  }
  lines.push('', '_The chart is now displayed to the user. Describe what it shows — do not repeat the table._');

  return { content: lines.join('\n'), data: { chart } };
}
