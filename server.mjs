// FileLLM local server.
//
// Binds to 127.0.0.1 only and requires a per-launch token on every /api route,
// so a random web page you happen to have open cannot drive your filesystem.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { runAgent } from './src/agent.mjs';
import { PROVIDERS, probe } from './src/providers.mjs';
import { TOOLS } from './src/tools/index.mjs';
import { getPlan, listPlans, applyPlan, discardPlan, undoJournal, listJournals, STATE_DIR } from './src/tools/mutate.mjs';
import { buildFixture, grade, cleanupFixture } from './src/selftest.mjs';
import { listDrives, HOME_DIR, defaultRoots, assertReadable } from './src/safety.mjs';
import { clearAllIndexes } from './src/walk.mjs';
import { humanBytes } from './src/util.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(ROOT, 'ui');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const PORT = Number(process.env.FILELLM_PORT) || 8777;
// Random per launch unless pinned, so the URL can be bookmarked if you want it to be.
const TOKEN = process.env.FILELLM_TOKEN || crypto.randomBytes(16).toString('hex');

const conversations = new Map(); // id -> message[]
const activeRuns = new Map(); // runId -> AbortController

// ------------------------------------------------------------- config

const DEFAULT_CONFIG = { provider: 'gemini', model: '', apiKey: '', baseUrl: '', temperature: 0.2, toolMode: 'native' };

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(cfg) {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  // The key lives in the user's own profile; keep it off other accounts.
  try {
    await fsp.chmod(CONFIG_FILE, 0o600);
  } catch {}
}

function resolveConfig(cfg) {
  const spec = PROVIDERS[cfg.provider] || PROVIDERS.gemini;
  return {
    ...cfg,
    model: cfg.model || spec.defaultModel,
    baseUrl: cfg.baseUrl || spec.baseUrl,
  };
}

// -------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      // Reject anything that did not come from our own page.
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):/.test(origin)) {
        return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      }
      const token = req.headers['x-filellm-token'] || url.searchParams.get('t');
      if (token !== TOKEN) {
        return json(res, 401, { error: 'Bad or missing session token. Reopen FileLLM from the link printed in the console.' });
      }
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('[filellm]', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

async function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) return json(res, 403, { error: 'nope' });

  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace('/api/', '');

  if (route === 'system' && req.method === 'GET') {
    const cfg = await loadConfig();
    return json(res, 200, {
      home: HOME_DIR,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      drives: listDrives().map((d) => ({ ...d, freeHuman: d.free != null ? humanBytes(d.free) : null, totalHuman: d.total != null ? humanBytes(d.total) : null })),
      roots: defaultRoots(),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, mutating: t.mutating, parameters: t.parameters })),
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel, needsKey: v.needsKey, cost: v.cost, help: v.help }])),
      config: { ...cfg, apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : '', hasKey: !!cfg.apiKey },
      node: process.version,
    });
  }

  if (route === 'config' && req.method === 'POST') {
    const body = await readJson(req);
    const current = await loadConfig();
    const next = { ...current, ...body };
    // An empty apiKey in the payload means "leave it alone", not "erase it".
    if (!body.apiKey) next.apiKey = current.apiKey;
    if (body.apiKey === null) next.apiKey = '';
    await saveConfig(next);
    return json(res, 200, { ok: true });
  }

  if (route === 'probe' && req.method === 'POST') {
    const cfg = resolveConfig(await loadConfig());
    try {
      const result = await probe(cfg);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message, provider: cfg.provider, model: cfg.model, help: PROVIDERS[cfg.provider]?.help });
    }
  }

  if (route === 'chat' && req.method === 'POST') {
    const { message, conversationId } = await readJson(req);
    const cfg = resolveConfig(await loadConfig());
    const convId = conversationId || crypto.randomUUID();
    const history = conversations.get(convId) || [];

    const sse = startSSE(res);
    const controller = new AbortController();
    let runId = null;

    req.on('close', () => controller.abort(new Error('client disconnected')));

    try {
      const result = await runAgent({
        history,
        userMessage: message,
        cfg,
        signal: controller.signal,
        emit: (ev) => {
          if (ev.type === 'run_start') {
            runId = ev.runId;
            activeRuns.set(runId, controller);
            sse.send({ ...ev, conversationId: convId });
            return;
          }
          sse.send(ev);
        },
      });
      conversations.set(convId, trimHistory(result.history));
      sse.send({ type: 'trace', trace: result.trace });
    } catch (err) {
      sse.send({ type: 'error', message: err.message });
    } finally {
      if (runId) activeRuns.delete(runId);
      sse.close();
    }
    return;
  }

  if (route === 'cancel' && req.method === 'POST') {
    const { runId } = await readJson(req);
    const c = activeRuns.get(runId);
    if (c) c.abort(new Error('cancelled by user'));
    return json(res, 200, { ok: !!c });
  }

  if (route === 'conversation/reset' && req.method === 'POST') {
    const { conversationId } = await readJson(req);
    conversations.delete(conversationId);
    return json(res, 200, { ok: true });
  }

  if (route === 'plans' && req.method === 'GET') {
    return json(res, 200, { plans: listPlans() });
  }

  if (route.startsWith('plans/') && req.method === 'POST') {
    const [, id, action] = route.split('/');
    if (action === 'approve') {
      const plan = getPlan(id);
      if (!plan) return json(res, 404, { error: 'That plan is no longer pending.' });
      const sse = startSSE(res);
      try {
        const result = await applyPlan(id, { onProgress: (p) => sse.send({ type: 'apply_progress', ...p }) });
        sse.send({ type: 'apply_done', ...result });
      } catch (err) {
        sse.send({ type: 'error', message: err.message });
      }
      sse.close();
      return;
    }
    if (action === 'discard') {
      return json(res, 200, { ok: discardPlan(id) });
    }
  }

  if (route === 'undo' && req.method === 'GET') {
    return json(res, 200, { journals: await listJournals() });
  }
  if (route.startsWith('undo/') && req.method === 'POST') {
    const id = route.split('/')[1];
    return json(res, 200, await undoJournal(id));
  }

  if (route === 'selftest' && req.method === 'POST') {
    const cfg = resolveConfig(await loadConfig());
    const sse = startSSE(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client disconnected')));

    let fixture = null;
    try {
      sse.send({ type: 'selftest_setup', message: 'Generating a random token and building a folder of decoy documents…' });
      fixture = await buildFixture();
      sse.send({
        type: 'selftest_fixture',
        dir: fixture.dir,
        token: fixture.token,
        decoyCount: fixture.decoyCount,
        target: fixture.target,
        trap: fixture.trap,
        nearMiss: fixture.nearMiss,
        prompt: fixture.prompt,
      });

      const result = await runAgent({
        history: [],
        userMessage: fixture.prompt,
        cfg,
        signal: controller.signal,
        emit: (ev) => sse.send(ev),
      });

      const report = grade(fixture, result);
      sse.send({ type: 'selftest_result', report, finalText: result.finalText, trace: result.trace });
    } catch (err) {
      sse.send({ type: 'error', message: err.message });
    } finally {
      if (fixture) {
        try {
          await cleanupFixture(fixture.dir);
          sse.send({ type: 'selftest_cleanup', dir: fixture.dir });
        } catch {}
      }
      sse.close();
    }
    return;
  }

  if (route === 'reveal' && req.method === 'POST') {
    const { path: target } = await readJson(req);
    try {
      const abs = assertReadable(target);
      const isDir = fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory();
      execFile('explorer.exe', isDir ? [abs] : ['/select,', abs], () => {});
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (route === 'cache/clear' && req.method === 'POST') {
    clearAllIndexes();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: `No route ${req.method} /api/${route}` });
}

// ------------------------------------------------------------ helpers

/** Keep context bounded: last ~24 messages, and never start on a tool result. */
function trimHistory(history) {
  let trimmed = history.slice(-24);
  while (trimmed.length && trimmed[0].role === 'tool') trimmed = trimmed.slice(1);
  return trimmed;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function startSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let open = true;
  return {
    send(obj) {
      if (!open) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        open = false;
      }
    },
    close() {
      if (!open) return;
      open = false;
      try {
        res.write('data: {"type":"done"}\n\n');
        res.end();
      } catch {}
    },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

// --------------------------------------------------------------- boot

server.listen(PORT, '127.0.0.1', async () => {
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  const cfg = await loadConfig();

  console.log('');
  console.log('  FileLLM is running.');
  console.log('  ------------------------------------------------------------');
  console.log(`  Open:     ${link}`);
  console.log(`  Provider: ${PROVIDERS[cfg.provider]?.label || cfg.provider}${cfg.apiKey || !PROVIDERS[cfg.provider]?.needsKey ? '' : '  (no API key set yet — set one in Settings)'}`);
  console.log(`  State:    ${STATE_DIR}`);
  console.log('  ------------------------------------------------------------');
  console.log('  Leave this window open. Close it to stop FileLLM.');
  console.log('');

  if (!process.env.FILELLM_NO_OPEN) {
    execFile('cmd', ['/c', 'start', '""', link], { windowsHide: true }, () => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — FileLLM may already be running.`);
    console.error(`  Try opening http://127.0.0.1:${PORT}/ , or set FILELLM_PORT to a different port.\n`);
    process.exit(1);
  }
  throw err;
});
