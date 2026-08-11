// FileLLM front-end. No framework, no build step.

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let SYSTEM = null;
let conversationId = crypto.randomUUID();
let currentRunId = null;
let busy = false;

// ------------------------------------------------------------- network

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-filellm-token': TOKEN, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** POST and consume a server-sent-event stream, calling onEvent per message. */
async function stream(path, payload, onEvent) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-filellm-token': TOKEN },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.type === 'done') return;
      onEvent(ev);
    }
  }
}

// ---------------------------------------------------------- markdown

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const QUOTE_RE = /^\s*(?:&gt;|>)/;

/** Small deliberate subset: headings, tables, lists, quotes, code, emphasis. */
function markdown(src) {
  const fences = [];
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `%%FENCE${fences.length - 1}%%`;
  });

  text = escapeHtml(text);

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^%%FENCE(\d+)%%$/.exec(line.trim());
    if (fence) {
      out.push(fences[+fence[1]]);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)[0].length + 1, 6);
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(---+|___+|\*\*\*+)$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }
    // table
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>'
      );
      continue;
    }
    // Escaping has already turned "> quote" into "&gt; quote", so match both forms.
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s*(?:&gt;|>)\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i])) {
        items.push(inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '')));
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${t}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(?:&gt;|>)|\s*([-*+]|\d+\.)\s|%%FENCE)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Turn <code> spans that look like Windows paths into click-to-reveal links. */
function linkifyPaths(container) {
  for (const code of container.querySelectorAll('code')) {
    const t = code.textContent;
    if (!/^[A-Za-z]:\\/.test(t) || t.length > 400) continue;
    code.classList.add('reveal-link');
    code.title = 'Open in File Explorer';
    code.onclick = () => api('reveal', { method: 'POST', body: JSON.stringify({ path: t }) }).catch((e) => alert(e.message));
  }
}

// ------------------------------------------------------------ charts

const CHART_COLORS = [
  '#5b9dff', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee',
  '#fb923c', '#a3e635', '#f472b6', '#38bdf8', '#facc15', '#94a3b8',
];

/** Point on a circle, angle measured clockwise from 12 o'clock. */
function polar(cx, cy, r, angle) {
  const a = (angle - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, rOuter, rInner, start, end) {
  // A full circle cannot be drawn with one arc — the start and end points
  // coincide and the path collapses. Use two half arcs instead.
  if (end - start >= 359.999) {
    const [x1, y1] = polar(cx, cy, rOuter, 0);
    const [x2, y2] = polar(cx, cy, rOuter, 180);
    const outer = `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 1 1 ${x2} ${y2} A ${rOuter} ${rOuter} 0 1 1 ${x1} ${y1} Z`;
    if (!rInner) return outer;
    const [i1, j1] = polar(cx, cy, rInner, 0);
    const [i2, j2] = polar(cx, cy, rInner, 180);
    return `${outer} M ${i1} ${j1} A ${rInner} ${rInner} 0 1 0 ${i2} ${j2} A ${rInner} ${rInner} 0 1 0 ${i1} ${j1} Z`;
  }

  const large = end - start > 180 ? 1 : 0;
  const [sx, sy] = polar(cx, cy, rOuter, start);
  const [ex, ey] = polar(cx, cy, rOuter, end);
  if (!rInner) {
    return `M ${cx} ${cy} L ${sx} ${sy} A ${rOuter} ${rOuter} 0 ${large} 1 ${ex} ${ey} Z`;
  }
  const [isx, isy] = polar(cx, cy, rInner, end);
  const [iex, iey] = polar(cx, cy, rInner, start);
  return `M ${sx} ${sy} A ${rOuter} ${rOuter} 0 ${large} 1 ${ex} ${ey} L ${isx} ${isy} A ${rInner} ${rInner} 0 ${large} 0 ${iex} ${iey} Z`;
}

function renderPie(chart) {
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const r = 104;
  const rInner = chart.type === 'donut' ? 58 : 0;

  let angle = 0;
  const paths = chart.slices
    .map((s, i) => {
      const sweep = (s.percent / 100) * 360;
      const d = arcPath(cx, cy, r, rInner, angle, angle + sweep);
      angle += sweep;
      return `<path d="${d}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" stroke="var(--bg-2)" stroke-width="1.5"><title>${escapeHtml(`${s.label}: ${s.display} (${s.percent.toFixed(1)}%)`)}</title></path>`;
    })
    .join('');

  const centre =
    chart.type === 'donut'
      ? `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="ch-centre-v">${escapeHtml(formatTotal(chart))}</text>` +
        `<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="ch-centre-l">total</text>`
      : '';

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(chart.title)}">${paths}${centre}</svg>`;
}

function renderBar(chart) {
  const rowH = 30;
  const gap = 8;
  const labelW = 132;
  const valueW = 78;
  const barW = 300;
  const width = labelW + barW + valueW;
  const height = chart.slices.length * (rowH + gap);
  const max = Math.max(...chart.slices.map((s) => s.value)) || 1;

  const rows = chart.slices
    .map((s, i) => {
      const y = i * (rowH + gap);
      const w = Math.max(2, (s.value / max) * barW);
      const colour = CHART_COLORS[i % CHART_COLORS.length];
      return (
        `<text x="${labelW - 10}" y="${y + rowH / 2 + 4}" text-anchor="end" class="ch-label">${escapeHtml(truncate(s.label, 20))}</text>` +
        `<rect x="${labelW}" y="${y + 4}" width="${w}" height="${rowH - 8}" rx="3" fill="${colour}"><title>${escapeHtml(`${s.label}: ${s.display}`)}</title></rect>` +
        `<text x="${labelW + w + 8}" y="${y + rowH / 2 + 4}" class="ch-value">${escapeHtml(s.display)}</text>`
      );
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapeHtml(chart.title)}">${rows}</svg>`;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatTotal(chart) {
  // The tool reports the total across every slice it was given, including any
  // it folded into "Other", so prefer it over re-summing what we drew.
  const t = Number.isFinite(chart.total) ? chart.total : chart.slices.reduce((a, b) => a + b.value, 0);
  if (chart.format === 'bytes') return fmtBytes(t);
  if (chart.format === 'percent') return `${t.toFixed(0)}%`;
  return t >= 1000 ? t.toLocaleString() : String(Math.round(t * 100) / 100);
}

function renderChartCard(chart) {
  const card = el('div', 'chart-card');
  const head = el('div', 'chart-head');
  head.appendChild(el('div', 'chart-title', chart.title));
  head.appendChild(el('div', 'chart-total', `total ${formatTotal(chart)}`));
  card.appendChild(head);

  const body = el('div', `chart-body ${chart.type === 'bar' ? 'is-bar' : ''}`);
  const figure = el('div', 'chart-figure');
  figure.innerHTML = chart.type === 'bar' ? renderBar(chart) : renderPie(chart);
  body.appendChild(figure);

  if (chart.type !== 'bar') {
    const legend = el('div', 'chart-legend');
    chart.slices.forEach((s, i) => {
      const row = el('div', 'chart-legend-row');
      const sw = el('span', 'sw');
      sw.style.background = CHART_COLORS[i % CHART_COLORS.length];
      row.appendChild(sw);
      row.appendChild(el('span', 'lg-label', truncate(s.label, 26)));
      row.appendChild(el('span', 'lg-value', `${s.display} · ${s.percent.toFixed(1)}%`));
      legend.appendChild(row);
    });
    body.appendChild(legend);
  }
  card.appendChild(body);

  if (chart.note) card.appendChild(el('div', 'chart-note', chart.note));
  return card;
}

function addChart(chart) {
  const wrap = el('div', 'msg agent chart-msg');
  wrap.appendChild(el('div', 'who', 'FileLLM'));
  wrap.appendChild(renderChartCard(chart));
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

// -------------------------------------------------------------- chat

const messages = $('#messages');

function addMessage(role, html, cls = '') {
  const wrap = el('div', `msg ${role} ${cls}`);
  wrap.appendChild(el('div', 'who', role === 'user' ? 'You' : role === 'error' ? 'Error' : 'FileLLM'));
  const bubble = el('div', 'bubble');
  bubble.innerHTML = html;
  linkifyPaths(bubble);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

// A run can take minutes on a local model, so the indicator shows what it is
// doing and how long it has been doing it — a bare spinner would look hung.
let thinkingEl = null;
let thinkingTimer = null;
let thinkingStarted = 0;

function showThinking(label = 'Thinking') {
  hideThinking();
  thinkingStarted = Date.now();

  thinkingEl = el('div', 'msg agent thinking');
  thinkingEl.appendChild(el('div', 'who', 'FileLLM'));
  const bubble = el('div', 'thinking-bubble');
  bubble.innerHTML =
    '<span class="spinner" aria-hidden="true"></span>' +
    `<span class="thinking-label">${escapeHtml(label)}</span>` +
    '<span class="thinking-dots"><i></i><i></i><i></i></span>' +
    '<span class="thinking-elapsed">0s</span>';
  thinkingEl.appendChild(bubble);
  messages.appendChild(thinkingEl);
  messages.scrollTop = messages.scrollHeight;

  thinkingTimer = setInterval(() => {
    if (!thinkingEl) return;
    const s = Math.round((Date.now() - thinkingStarted) / 1000);
    const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    thinkingEl.querySelector('.thinking-elapsed').textContent = text;
  }, 1000);
}

function updateThinking(label) {
  if (thinkingEl) thinkingEl.querySelector('.thinking-label').textContent = label;
}

function hideThinking() {
  if (thinkingTimer) clearInterval(thinkingTimer);
  thinkingTimer = null;
  thinkingEl?.remove();
  thinkingEl = null;
}

let activityBox = null;
function activity(text, detail, state = '') {
  if (!activityBox) {
    activityBox = el('div', 'activity');
    messages.appendChild(activityBox);
  }
  // Keep the thinking bubble pinned below the newest activity row.
  if (thinkingEl) messages.appendChild(thinkingEl);
  const row = el('div', `row ${state}`);
  row.appendChild(el('span', 'tick', state === 'done' ? '✓' : state === 'fail' ? '✗' : '▸'));
  const body = el('span');
  body.appendChild(el('span', '', text));
  if (detail) {
    body.appendChild(document.createTextNode(' '));
    body.appendChild(el('span', 'detail', detail));
  }
  row.appendChild(body);
  activityBox.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}

function setBusy(state) {
  busy = state;
  $('#btnSend').disabled = state;
  $('#btnProve').disabled = state;
  $('#btnStop').hidden = !state;
  $('#statusDot').className = `dot ${state ? 'busy' : SYSTEM ? 'live' : ''}`;
}

async function send(text) {
  if (busy || !text.trim()) return;
  addMessage('user', escapeHtml(text).replace(/\n/g, '<br>'));
  $('#input').value = '';
  $('#input').style.height = 'auto';
  activityBox = null;
  clearTrace();
  setBusy(true);
  showThinking('Thinking');

  try {
    await stream('chat', { message: text, conversationId }, handleAgentEvent);
  } catch (err) {
    addMessage('error', `<p>${escapeHtml(err.message)}</p>`, 'error');
  } finally {
    hideThinking();
    setBusy(false);
    currentRunId = null;
    refreshPlans();
  }
}

const pendingRows = new Map();

function handleAgentEvent(ev) {
  switch (ev.type) {
    case 'run_start':
      currentRunId = ev.runId;
      if (ev.conversationId) conversationId = ev.conversationId;
      renderRunHeader(ev);
      break;

    case 'assistant_text':
      if (ev.text.trim()) activity('Reasoning', ev.text.trim().slice(0, 150).replace(/\s+/g, ' '));
      break;

    case 'tool_call': {
      const row = activity(`Calling ${ev.name}`, summariseArgs(ev.args));
      pendingRows.set(ev.id, row);
      addTraceStep(ev);
      updateThinking(`Running ${ev.name}`);
      break;
    }

    case 'tool_progress':
      updateTraceProgress(ev);
      updateThinking(ev.message.length > 70 ? `${ev.message.slice(0, 70)}…` : ev.message);
      break;

    case 'tool_result': {
      const row = pendingRows.get(ev.id);
      if (row) {
        row.className = `row ${ev.ok ? 'done' : 'fail'}`;
        row.querySelector('.tick').textContent = ev.ok ? '✓' : '✗';
        const d = row.querySelector('.detail');
        if (d) d.textContent = `${ev.ms} ms`;
      }
      completeTraceStep(ev);
      if (ev.ok && ev.data?.chart) addChart(ev.data.chart);
      updateThinking('Thinking');
      break;
    }

    case 'http':
      addHttpRecord(ev.record);
      break;

    case 'notice':
      activity(ev.message, '', 'done');
      break;

    case 'final':
      hideThinking();
      addMessage('agent', markdown(ev.text));
      break;

    case 'plan':
      refreshPlans();
      break;

    case 'error':
      hideThinking();
      addMessage('error', `<p>${escapeHtml(ev.message)}</p>${ev.detail ? `<pre><code>${escapeHtml(JSON.stringify(ev.detail, null, 2)).slice(0, 1500)}</code></pre>` : ''}`, 'error');
      break;

    case 'run_end':
      hideThinking();
      activity(
        'Done',
        `${ev.steps} model turn${ev.steps === 1 ? '' : 's'} · ${ev.httpCalls} API call${ev.httpCalls === 1 ? '' : 's'} · ${((ev.durationMs || 0) / 1000).toFixed(1)}s · ${(ev.usage?.in || 0) + (ev.usage?.out || 0)} tokens`,
        'done'
      );
      break;

    case 'cancelled':
      hideThinking();
      activity('Cancelled', '', 'fail');
      break;
  }
}

function summariseArgs(args) {
  if (!args || !Object.keys(args).length) return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === '') continue;
    const s = Array.isArray(v) ? v.join(',') : String(v);
    parts.push(`${k}=${s.length > 44 ? s.slice(0, 44) + '…' : s}`);
  }
  return parts.join(' ');
}

// ------------------------------------------------------------- trace

const tracePanel = $('#panel-trace');
const proofPanel = $('#panel-proof');
const traceSteps = new Map();

function clearTrace() {
  tracePanel.innerHTML = '';
  proofPanel.innerHTML = '';
  traceSteps.clear();
}

function renderRunHeader(ev) {
  const h = el('div', 'run-header');
  h.innerHTML =
    `<b>run</b> ${escapeHtml(ev.runId)}<br>` +
    `<b>provider</b> ${escapeHtml(ev.provider)} &nbsp; <b>model</b> ${escapeHtml(ev.model)}<br>` +
    `<b>tools offered</b> ${ev.toolCount} &nbsp; <b>started</b> ${new Date(ev.at).toLocaleTimeString()}`;
  tracePanel.appendChild(h);
}

function addTraceStep(ev) {
  const d = el('details', 'step');
  d.open = true;
  const s = el('summary');
  s.appendChild(el('span', 'idx', `#${ev.step}`));
  s.appendChild(el('span', `name ${ev.mutating ? 'mutating' : ''}`, ev.name));
  s.appendChild(el('span', 'status', '⏳'));
  s.appendChild(el('span', 'ms', 'running'));
  d.appendChild(s);

  const body = el('div', 'body');
  body.appendChild(el('div', 'label', 'arguments the model chose'));
  body.appendChild(el('pre', '', JSON.stringify(ev.args, null, 2)));
  const progress = el('div', 'label prog');
  progress.style.display = 'none';
  body.appendChild(progress);
  d.appendChild(body);

  tracePanel.appendChild(d);
  traceSteps.set(ev.id, d);
  tracePanel.scrollTop = tracePanel.scrollHeight;
}

function updateTraceProgress(ev) {
  const d = traceSteps.get(ev.id);
  if (!d) return;
  const p = d.querySelector('.prog');
  p.style.display = '';
  p.textContent = ev.message;
}

function completeTraceStep(ev) {
  const d = traceSteps.get(ev.id);
  if (!d) return;
  d.querySelector('.status').textContent = ev.ok ? '✓' : '✗';
  d.querySelector('.status').style.color = ev.ok ? 'var(--good)' : 'var(--bad)';
  d.querySelector('.ms').textContent = `${ev.ms} ms`;
  const p = d.querySelector('.prog');
  if (p) p.style.display = 'none';

  const body = d.querySelector('.body');
  body.appendChild(el('div', 'label', `result — what the tool actually returned to the model`));
  body.appendChild(el('pre', '', ev.content));
  d.open = false;
}

function addHttpRecord(rec) {
  const d = el('details', 'http');
  const s = el('summary');
  const ok = rec.status >= 200 && rec.status < 300;
  s.appendChild(el('span', `code ${ok ? 'ok' : 'bad'}`, rec.status || 'ERR'));
  s.appendChild(el('span', 'u', rec.url));
  s.appendChild(el('span', 't', `${rec.ms} ms`));
  d.appendChild(s);

  const body = el('div', 'body');
  if (rec.error) {
    body.appendChild(el('div', 'label', 'error'));
    body.appendChild(el('pre', '', rec.error));
  }
  body.appendChild(el('div', 'label', 'request body sent to the model'));
  body.appendChild(el('pre', '', JSON.stringify(rec.request, null, 2)));
  body.appendChild(el('div', 'label', 'response body from the model'));
  body.appendChild(el('pre', '', typeof rec.response === 'string' ? rec.response : JSON.stringify(rec.response, null, 2)));
  d.appendChild(body);

  proofPanel.appendChild(d);
}

// --------------------------------------------------------- approvals

async function refreshPlans() {
  const { plans } = await api('plans');
  const panel = $('#panel-approvals');
  const badge = $('#planBadge');
  badge.textContent = plans.length;
  badge.className = `badge ${plans.length ? '' : 'zero'}`;
  panel.innerHTML = '';

  if (!plans.length) {
    panel.appendChild(el('div', 'empty', 'Proposed file changes land here. Nothing runs until you approve it.'));
    return;
  }

  for (const plan of plans) {
    const card = el('div', 'plan');
    const head = el('div', 'head');
    head.appendChild(el('div', 'title', plan.summary));
    head.appendChild(
      el('div', 'meta', `${plan.operations.length} operation(s) · ${plan.totalFiles.toLocaleString()} file(s) · ${fmtBytes(plan.totalBytes)}`)
    );
    card.appendChild(head);

    const ops = el('div', 'ops');
    for (const o of plan.operations) {
      const row = el('div', 'op');
      const line = el('div');
      line.appendChild(el('span', 'a', o.action));
      line.appendChild(el('span', 'p', o.destination && o.action !== 'create_folder' ? `${o.path} → ${o.destination}` : o.path || o.destination));
      row.appendChild(line);
      if (o.bytes) row.appendChild(el('div', 'r', `${fmtBytes(o.bytes)}${o.files > 1 ? ` · ${o.files} files` : ''}${o.reason ? ` — ${o.reason}` : ''}`));
      else if (o.reason) row.appendChild(el('div', 'r', o.reason));
      ops.appendChild(row);
    }
    card.appendChild(ops);

    const foot = el('div', 'foot');
    const note = el('div', 'note', 'Deletions go to the Recycle Bin. Moves are undoable.');
    const approve = el('button', 'btn good sm', 'Approve & run');
    const discard = el('button', 'btn sm', 'Discard');

    approve.onclick = async () => {
      approve.disabled = discard.disabled = true;
      note.textContent = 'Running…';
      try {
        await stream(`plans/${plan.id}/approve`, {}, (ev) => {
          if (ev.type === 'apply_progress') note.textContent = ev.note || `${ev.done}/${ev.total}`;
          if (ev.type === 'apply_done') {
            const summary =
              `${ev.okCount} succeeded` +
              (ev.failCount ? `, ${ev.failCount} failed` : '') +
              (ev.reclaimed ? `, ${fmtBytes(ev.reclaimed)} reclaimed` : '');
            addMessage('agent', markdown(`**Applied: ${plan.summary}**\n\n${summary}.\n\n${ev.results.filter((r) => !r.ok).map((r) => `- \`${r.op.path}\` — ${r.error}`).join('\n')}\n\n_Reversible from the Undo tab._`));
          }
          if (ev.type === 'error') addMessage('error', `<p>${escapeHtml(ev.message)}</p>`, 'error');
        });
      } catch (err) {
        addMessage('error', `<p>${escapeHtml(err.message)}</p>`, 'error');
      }
      refreshPlans();
      refreshUndo();
    };

    discard.onclick = async () => {
      await api(`plans/${plan.id}/discard`, { method: 'POST', body: '{}' });
      refreshPlans();
    };

    foot.appendChild(approve);
    foot.appendChild(discard);
    foot.appendChild(note);
    card.appendChild(foot);
    panel.appendChild(card);
  }
}

async function refreshUndo() {
  const { journals } = await api('undo');
  const panel = $('#panel-undo');
  panel.innerHTML = '';
  if (!journals.length) {
    panel.appendChild(el('div', 'empty', 'Applied changes can be reversed from here.'));
    return;
  }
  for (const j of journals) {
    const card = el('div', 'plan');
    const head = el('div', 'head');
    head.appendChild(el('div', 'title', j.summary));
    head.appendChild(el('div', 'meta', `${j.count} change(s) · ${new Date(j.at).toLocaleString()}`));
    card.appendChild(head);
    const foot = el('div', 'foot');
    const note = el('div', 'note', 'Recycled items are restored from the Recycle Bin itself.');
    const btn = el('button', 'btn sm', 'Undo');
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await api(`undo/${j.id}`, { method: 'POST', body: '{}' });
      addMessage('agent', markdown(`**Undo: ${j.summary}**\n\n` + r.results.map((x) => `- ${x.ok ? '✓' : '⚠'} ${x.note}`).join('\n')));
      refreshUndo();
    };
    foot.appendChild(btn);
    foot.appendChild(note);
    card.appendChild(foot);
    panel.appendChild(card);
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

// -------------------------------------------------------- self-test

async function runSelfTest() {
  if (busy) return;
  showPanel('trace');
  activityBox = null;
  clearTrace();
  setBusy(true);
  showThinking('Building the test fixture');

  addMessage(
    'agent',
    markdown(
      `### Proving this is a real agent\n\nI'm going to generate a random reference code that cannot exist in any model's training data, hide it inside a real \`.docx\` file among dozens of decoys, plant a **trap** copy with the same code but a different year, and then ask myself to find it in plain English — without being told the filename, the folder, or which tool to use.\n\nWatch the Trace and Proof tabs.`
    )
  );

  let fixture = null;
  try {
    await stream('selftest', {}, (ev) => {
      if (ev.type === 'selftest_setup') {
        activity(ev.message);
        return;
      }
      if (ev.type === 'selftest_fixture') {
        fixture = ev;
        const box = el('div', 'fixture');
        box.innerHTML =
          `<b>token</b> <span class="tok">${escapeHtml(ev.token)}</span> &nbsp;(generated ${new Date().toLocaleTimeString()})<br>` +
          `<b>haystack</b> ${ev.decoyCount} decoy files<br>` +
          `<b>answer</b> ${escapeHtml(ev.target.name)} &nbsp;(${new Date(ev.target.mtime).getFullYear()})<br>` +
          `<b>trap</b> ${escapeHtml(ev.trap.name)} &nbsp;(${new Date(ev.trap.mtime).getFullYear()}, same token)<br>` +
          `<b>near-miss</b> ${escapeHtml(ev.nearMiss)}<br>` +
          `<b>dir</b> ${escapeHtml(ev.dir)}`;
        tracePanel.appendChild(box);
        addMessage('user', escapeHtml(ev.prompt));
        activity('Fixture built — the agent has not been told any of the above', '', 'done');
        return;
      }
      if (ev.type === 'selftest_result') {
        renderVerdict(ev.report, fixture);
        return;
      }
      if (ev.type === 'selftest_cleanup') {
        activity('Test files removed', ev.dir, 'done');
        return;
      }
      handleAgentEvent(ev);
    });
  } catch (err) {
    addMessage('error', `<p>${escapeHtml(err.message)}</p>`, 'error');
  } finally {
    hideThinking();
    setBusy(false);
  }
}

function renderVerdict(report, fixture) {
  const html = [];
  html.push(
    `<div class="verdict ${report.verdict === 'PASS' ? 'pass' : 'fail'}">${report.verdict}` +
      `<small>${report.passed} of ${report.total} checks passed</small></div>`
  );
  html.push('<div>');
  for (const c of report.checks) {
    html.push(
      `<div class="check"><span class="mark ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✗'}</span>` +
        `<span><div>${escapeHtml(c.label)}</div><div class="d">${escapeHtml(c.detail)}</div></span></div>`
    );
  }
  html.push('</div>');

  const bubble = addMessage('agent', '');
  bubble.innerHTML = html.join('');
  bubble.appendChild(
    document.createRange().createContextualFragment(
      markdown(
        `\n**Why this can't be faked:** the token \`${report.token}\` was generated seconds ago from \`crypto.randomBytes\`, ` +
          `so it cannot have been memorised. It lives only inside DEFLATE-compressed XML inside a ZIP container, so a filename ` +
          `search can't reach it. And a second file contains the *same* token with a different modification year — answering ` +
          `correctly requires actually reasoning about the date filter, not just matching text.\n\n` +
          `Expected answer: \`${report.expected}\``
      )
    )
  );
  linkifyPaths(bubble);
}

// ---------------------------------------------------------- settings

async function loadSystem() {
  SYSTEM = await api('system');
  const spec = SYSTEM.providers[SYSTEM.config.provider];
  $('#providerPill').textContent = `${spec?.label || SYSTEM.config.provider} · ${SYSTEM.config.model || spec?.defaultModel || ''}`;
  const free = /free/i.test(spec?.cost || '');
  $('#costPill').hidden = !free;
  $('#costPill').textContent = spec?.cost || '';
  $('#statusDot').className = 'dot live';
  $('#brandSub').textContent = `${SYSTEM.hostname} · node ${SYSTEM.node}`;

  const drives = SYSTEM.drives.filter((d) => d.total).map((d) => `${d.path} ${d.freeHuman} free of ${d.totalHuman}`).join(' · ');
  $('#sysLine').innerHTML = `<em>Connected to this machine: ${escapeHtml(drives)}. ${SYSTEM.tools.length} tools available.</em>`;

  if (spec?.needsKey && !SYSTEM.config.hasKey) openSettings();
}

function openSettings() {
  const sel = $('#fProvider');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(SYSTEM.providers)) {
    const opt = el('option', '', `${p.label} — ${p.cost}`);
    opt.value = key;
    sel.appendChild(opt);
  }
  sel.value = SYSTEM.config.provider;
  $('#fModel').value = SYSTEM.config.model || '';
  $('#fModel').placeholder = SYSTEM.providers[sel.value]?.defaultModel || '';
  $('#fKey').value = '';
  $('#fKey').placeholder = SYSTEM.config.hasKey ? `saved: ${SYSTEM.config.apiKey}` : 'paste your key';
  $('#fToolMode').value = SYSTEM.config.toolMode || 'native';
  $('#fTimeout').value = SYSTEM.config.timeoutSeconds || 0;
  $('#probeResult').innerHTML = '';
  updateProviderHint();
  $('#settingsOverlay').classList.add('open');
}

function updateProviderHint() {
  const key = $('#fProvider').value;
  const p = SYSTEM.providers[key];
  $('#providerHint').innerHTML = escapeHtml(p.help).replace(
    /((?:aistudio|console|cloud|openrouter|platform)[^\s,]+)/g,
    '<a href="https://$1" target="_blank" rel="noopener">$1</a>'
  );
  $('#fModel').placeholder = p.defaultModel;
  $('#keyField').style.display = p.needsKey ? '' : 'none';
}

// -------------------------------------------------------------- wiring

function showPanel(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.panel === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${name}`);
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => showPanel(tab.dataset.panel);
}

$('#btnSend').onclick = () => send($('#input').value);
$('#btnStop').onclick = () => api('cancel', { method: 'POST', body: JSON.stringify({ runId: currentRunId }) });
$('#btnProve').onclick = runSelfTest;
$('#btnSettings').onclick = openSettings;
$('#btnNew').onclick = async () => {
  await api('conversation/reset', { method: 'POST', body: JSON.stringify({ conversationId }) });
  conversationId = crypto.randomUUID();
  messages.querySelectorAll('.msg:not(:first-child), .activity').forEach((n) => n.remove());
  clearTrace();
  activityBox = null;
};

$('#input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send($('#input').value);
  }
};
$('#input').oninput = (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
};

$('#fProvider').onchange = updateProviderHint;
$('#btnCancelSettings').onclick = () => $('#settingsOverlay').classList.remove('open');
$('#settingsOverlay').onclick = (e) => {
  if (e.target.id === 'settingsOverlay') $('#settingsOverlay').classList.remove('open');
};

$('#btnSaveSettings').onclick = async () => {
  await api('config', {
    method: 'POST',
    body: JSON.stringify({
      provider: $('#fProvider').value,
      model: $('#fModel').value.trim(),
      apiKey: $('#fKey').value.trim(),
      toolMode: $('#fToolMode').value,
      timeoutSeconds: Number($('#fTimeout').value) || 0,
    }),
  });
  $('#settingsOverlay').classList.remove('open');
  await loadSystem();
};

$('#btnProbe').onclick = async () => {
  const box = $('#probeResult');
  box.className = 'probe-result';
  box.textContent = 'Saving settings and calling the model…';
  await api('config', {
    method: 'POST',
    body: JSON.stringify({
      provider: $('#fProvider').value,
      model: $('#fModel').value.trim(),
      apiKey: $('#fKey').value.trim(),
      toolMode: $('#fToolMode').value,
      timeoutSeconds: Number($('#fTimeout').value) || 0,
    }),
  });
  try {
    const r = await api('probe', { method: 'POST', body: '{}' });
    if (r.ok) {
      box.className = 'probe-result ok';
      box.textContent = `Connected. ${r.label}\nmodel: ${r.model}\nreplied "${r.reply}" in ${r.ms} ms\ntokens: ${r.usage?.in ?? '?'} in / ${r.usage?.out ?? '?'} out`;
    } else {
      box.className = 'probe-result err';
      box.textContent = `${r.error}\n\n${r.help || ''}`;
    }
  } catch (err) {
    box.className = 'probe-result err';
    box.textContent = err.message;
  }
  await loadSystem();
};

$('#btnClearCache').onclick = async () => {
  await api('cache/clear', { method: 'POST', body: '{}' });
  $('#probeResult').className = 'probe-result ok';
  $('#probeResult').textContent = 'Scan cache cleared. The next scan will re-read the disk.';
};

const EXAMPLES = [
  "my storage is too full — what's causing it and what should I delete?",
  'make a pie chart of what is using space on C:',
  'find all documents from 2018 containing the word "hello"',
  'what are the 20 biggest files in my Downloads folder?',
  'find duplicate photos in my Pictures folder',
  'which folders on C: have grown the most?',
  'find every PDF I have not opened since 2022 and move them to an Archive folder',
];

for (const ex of EXAMPLES) {
  const b = el('button', 'example', ex);
  b.onclick = () => {
    $('#input').value = ex;
    $('#input').focus();
    $('#input').dispatchEvent(new Event('input'));
  };
  $('#examples').appendChild(b);
}

if (!TOKEN) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:system-ui;color:#e6e9ef">' +
    '<h2>Missing session token</h2>' +
    '<p>Open FileLLM using the link printed in the console window, which includes a one-time token.</p></div>';
} else {
  loadSystem().catch((e) => addMessage('error', `<p>${escapeHtml(e.message)}</p>`, 'error'));
  refreshPlans().catch(() => {});
  refreshUndo().catch(() => {});
}
