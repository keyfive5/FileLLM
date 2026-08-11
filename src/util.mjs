// Small helpers used across FileLLM. No dependencies on purpose.

/** Run `worker` over `items` with at most `limit` in flight. Preserves order. */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Let the event loop breathe so SSE progress actually flushes mid-scan. */
export function yieldToLoop() {
  return new Promise((r) => setImmediate(r));
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1);
  return `${n < 0 ? '-' : ''}${s} ${u[i]}`;
}

/**
 * Parse the loose date expressions people actually type: "2018", "last year",
 * "before 2020-03", "past 6 months". Returns {from, to} epoch ms, either nullable.
 */
export function parseDateRange(expr, now = Date.now()) {
  if (!expr) return { from: null, to: null };
  const s = String(expr).trim().toLowerCase();

  const year = s.match(/^(\d{4})$/);
  if (year) {
    const y = +year[1];
    return { from: Date.UTC(y, 0, 1), to: Date.UTC(y + 1, 0, 1) - 1 };
  }

  const month = s.match(/^(\d{4})-(\d{1,2})$/);
  if (month) {
    const y = +month[1];
    const m = +month[2] - 1;
    return { from: Date.UTC(y, m, 1), to: Date.UTC(y, m + 1, 1) - 1 };
  }

  const rel = s.match(/^(?:past|last)\s+(\d+)\s*(day|week|month|year)s?$/);
  if (rel) {
    const n = +rel[1];
    const mult = { day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2]];
    return { from: now - n * mult, to: now };
  }

  if (s === 'today') {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from: start, to: start + 864e5 - 1 };
  }
  if (s === 'this year') {
    const y = new Date(now).getFullYear();
    return { from: new Date(y, 0, 1).getTime(), to: now };
  }
  if (s === 'last year') {
    const y = new Date(now).getFullYear() - 1;
    return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() - 1 };
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? { from: null, to: null } : { from: t, to: t };
}

/** Glob -> RegExp. Supports *, ?, and {a,b} alternation. Case-insensitive. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^\\\\/]*';
    else if (c === '?') re += '[^\\\\/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable short id for cache filenames and run ids. */
export function shortId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Truncate a tool result so we never blow the model's context window. */
export function capText(s, max = 12000) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} more characters]`;
}
