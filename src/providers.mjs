// Model adapters.
//
// Everything is normalised to one internal shape so the agent loop never knows
// or cares which provider is behind it:
//
//   message  = { role:'system'|'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name? }
//   response = { text, toolCalls:[{id,name,args}], usage:{in,out}, stopReason, model }
//
// Every request and response is handed to `onHttp` verbatim (minus the API key)
// so the UI can show the real wire traffic. That is the proof.

export const PROVIDERS = {
  ollama: {
    label: 'Ollama (local, free, offline)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3:4b',
    needsKey: false,
    cost: 'free',
    help: 'Install Ollama, then run: ollama pull qwen3:4b. Nothing leaves your machine.',
  },
  lmstudio: {
    label: 'LM Studio (local, free, offline)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    needsKey: false,
    cost: 'free',
    help: 'Start LM Studio, load a model, and turn on its local server.',
  },
  gemini: {
    label: 'Google Gemini (free tier)',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    cost: 'free tier, no card required',
    help: 'Get a key at aistudio.google.com/apikey — the free tier needs no credit card.',
  },
  groq: {
    label: 'Groq (free tier)',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
    cost: 'free tier',
    help: 'Get a key at console.groq.com/keys.',
  },
  cerebras: {
    label: 'Cerebras (free tier)',
    protocol: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    needsKey: true,
    cost: 'free tier',
    help: 'Get a key at cloud.cerebras.ai.',
  },
  openrouter: {
    label: 'OpenRouter (has free models)',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    needsKey: true,
    cost: 'free with :free models',
    help: 'Get a key at openrouter.ai/keys and pick any model ending in ":free".',
  },
  anthropic: {
    label: 'Anthropic Claude (paid)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    needsKey: true,
    cost: 'paid',
    help: 'Get a key at console.anthropic.com.',
  },
  openai: {
    label: 'OpenAI (paid)',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    cost: 'paid',
    help: 'Get a key at platform.openai.com/api-keys.',
  },
};

class ProviderError extends Error {
  constructor(message, { status, body, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.provider = provider;
  }
}

/**
 * One model turn.
 * @param {object} cfg  {provider, model, apiKey, baseUrl, temperature, toolMode}
 */
export async function chat({ cfg, messages, tools, onHttp, signal, onSlow }) {
  const spec = PROVIDERS[cfg.provider];
  if (!spec) throw new ProviderError(`Unknown provider "${cfg.provider}"`);
  if (spec.needsKey && !cfg.apiKey) {
    throw new ProviderError(`${spec.label} needs an API key. ${spec.help}`, { provider: cfg.provider });
  }

  const useJsonTools = cfg.toolMode === 'json';
  const effectiveTools = useJsonTools ? null : tools;
  const prepared = useJsonTools ? injectJsonToolProtocol(messages, tools) : messages;

  const impl = { openai: callOpenAI, gemini: callGemini, anthropic: callAnthropic }[spec.protocol];
  const result = await impl({ cfg, spec, messages: prepared, tools: effectiveTools, onHttp, signal, onSlow });

  if (useJsonTools) return parseJsonToolCalls(result);
  return result;
}

/** Quick liveness probe used by the Proof panel. */
export async function probe(cfg) {
  const spec = PROVIDERS[cfg.provider];
  const started = Date.now();
  const records = [];
  const res = await chat({
    cfg,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    tools: null,
    onHttp: (r) => records.push(r),
  });
  return {
    ok: true,
    provider: cfg.provider,
    label: spec.label,
    model: res.model || cfg.model,
    reply: res.text.trim().slice(0, 100),
    ms: Date.now() - started,
    usage: res.usage,
    http: records,
  };
}

// ------------------------------------------------------- shared plumbing

async function post(url, { headers, body, onHttp, signal, provider, timeoutMs = 300000, onSlow }) {
  const started = Date.now();
  const controller = new AbortController();

  // A plain setTimeout does not advance while the machine is asleep, so also
  // check wall-clock elapsed time on a short interval. Otherwise a laptop that
  // sleeps mid-request wakes up still waiting on a long-dead connection.
  const deadline = started + timeoutMs;
  const ticker = setInterval(() => {
    if (Date.now() >= deadline) controller.abort(new Error(`timed out after ${Math.round((Date.now() - started) / 1000)}s`));
  }, 2000);
  const slowTimer = onSlow ? setTimeout(() => onSlow(Math.round(timeoutMs / 1000)), 20000) : null;
  const clean = () => {
    clearInterval(ticker);
    if (slowTimer) clearTimeout(slowTimer);
  };

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    clean();
    const record = {
      url,
      method: 'POST',
      request: redact(body),
      status: 0,
      ms: Date.now() - started,
      error: describeNetworkError(err, url, provider),
    };
    onHttp?.(record);
    throw new ProviderError(record.error, { provider });
  }
  clean();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  onHttp?.({
    url,
    method: 'POST',
    request: redact(body),
    requestHeaders: redactHeaders(headers),
    status: res.status,
    ms: Date.now() - started,
    response: json ?? text.slice(0, 4000),
  });

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 500);
    throw new ProviderError(`${provider} returned HTTP ${res.status}: ${detail}`, { status: res.status, body: json ?? text, provider });
  }
  if (!json) throw new ProviderError(`${provider} returned a non-JSON response`, { body: text.slice(0, 500), provider });
  return json;
}

function describeNetworkError(err, url, provider) {
  const msg = String(err?.message || err);
  const local = url.includes('127.0.0.1') || url.includes('localhost');

  if (/timed out/i.test(msg)) {
    return local
      ? `The local model at ${new URL(url).origin} ${msg}. Small models on CPU can take minutes per step — try a smaller model, or switch to a free hosted provider (Gemini/Groq) in Settings.`
      : `${provider} ${msg}.`;
  }
  if (/abort|cancel/i.test(msg)) return `Request to ${provider} was cancelled.`;
  if (local) {
    return `Could not reach the local model server at ${new URL(url).origin}. Is ${provider === 'ollama' ? 'Ollama' : 'LM Studio'} running? (${msg})`;
  }
  return `Network error talking to ${provider}: ${msg}`;
}

function redact(body) {
  return body;
}

function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /key|auth/i.test(k) ? `${String(v).slice(0, 8)}…[redacted]` : v;
  }
  return out;
}

// ---------------------------------------------------------------- OpenAI

async function callOpenAI({ cfg, spec, messages, tools, onHttp, signal, onSlow }) {
  const url = `${(cfg.baseUrl || spec.baseUrl).replace(/\/$/, '')}/chat/completions`;

  const body = {
    model: cfg.model || spec.defaultModel,
    messages: messages.map(toOpenAIMessage),
    temperature: cfg.temperature ?? 0.2,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }

  // Reasoning models burn a lot of tokens per turn, which on CPU inference means
  // minutes per step. We only need the tool choice, so turn thinking off where
  // the server understands the flag; it is ignored elsewhere.
  if (cfg.provider === 'ollama') body.think = false;

  const headers = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost/filellm';
    headers['X-Title'] = 'FileLLM';
  }

  const json = await post(url, { headers, body, onHttp, signal, onSlow, provider: cfg.provider });
  const choice = json.choices?.[0];
  const msg = choice?.message || {};

  return {
    text: typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '',
    toolCalls: (msg.tool_calls || []).map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function?.name,
      args: safeParseArgs(tc.function?.arguments),
    })),
    usage: { in: json.usage?.prompt_tokens ?? null, out: json.usage?.completion_tokens ?? null },
    stopReason: choice?.finish_reason || null,
    model: json.model || body.model,
    raw: json,
  };
}

function toOpenAIMessage(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) } })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

// ---------------------------------------------------------------- Gemini

async function callGemini({ cfg, spec, messages, tools, onHttp, signal, onSlow }) {
  const model = cfg.model || spec.defaultModel;
  const url = `${(cfg.baseUrl || spec.baseUrl).replace(/\/$/, '')}/models/${model}:generateContent`;

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.args ?? {} } });
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: m.content ?? '' }] });
  }

  const body = { contents, generationConfig: { temperature: cfg.temperature ?? 0.2 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map(toGeminiDeclaration) }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const json = await post(url, {
    headers: { 'x-goog-api-key': cfg.apiKey },
    body,
    onHttp,
    signal,
    onSlow,
    provider: 'gemini',
  });

  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const toolCalls = [];
  let text = '';
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      });
    }
  }

  if (!parts.length && cand?.finishReason && cand.finishReason !== 'STOP') {
    text = `[model stopped: ${cand.finishReason}]`;
  }

  return {
    text,
    toolCalls,
    usage: { in: json.usageMetadata?.promptTokenCount ?? null, out: json.usageMetadata?.candidatesTokenCount ?? null },
    stopReason: cand?.finishReason || null,
    model,
    raw: json,
  };
}

/** Gemini rejects a parameters object with no properties, and wants uppercase types. */
function toGeminiDeclaration(t) {
  const decl = { name: t.name, description: t.description };
  const props = t.parameters?.properties || {};
  if (Object.keys(props).length) decl.parameters = upperTypes(t.parameters);
  return decl;
}

function upperTypes(schema) {
  if (Array.isArray(schema)) return schema.map(upperTypes);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
    else if (k === 'properties') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, upperTypes(pv)]));
    } else if (k === 'items') out[k] = upperTypes(v);
    else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------- Anthropic

async function callAnthropic({ cfg, spec, messages, tools, onHttp, signal, onSlow }) {
  const url = `${(cfg.baseUrl || spec.baseUrl).replace(/\/$/, '')}/messages`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

  const converted = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const last = converted[converted.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
      if (content.length) converted.push({ role: 'assistant', content });
      continue;
    }
    converted.push({ role: 'user', content: m.content ?? '' });
  }

  const body = {
    model: cfg.model || spec.defaultModel,
    max_tokens: 4096,
    temperature: cfg.temperature ?? 0.2,
    messages: converted,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const json = await post(url, {
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    onHttp,
    signal,
    onSlow,
    provider: 'anthropic',
  });

  let text = '';
  const toolCalls = [];
  for (const block of json.content || []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
  }

  return {
    text,
    toolCalls,
    usage: { in: json.usage?.input_tokens ?? null, out: json.usage?.output_tokens ?? null },
    stopReason: json.stop_reason || null,
    model: json.model || body.model,
    raw: json,
  };
}

// --------------------------------------------- JSON tool-call fallback
// Small local models often have no native function calling. This teaches them
// a plain-text protocol instead, so FileLLM still works fully offline.

function injectJsonToolProtocol(messages, tools) {
  if (!tools?.length) return messages;
  const spec = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters.properties || {})}`)
    .join('\n');

  const instruction = `
You cannot call functions directly. To use a tool, reply with ONLY a fenced json block:

\`\`\`json
{"tool": "<tool name>", "args": { ... }}
\`\`\`

Emit exactly one tool block per reply and no other text when calling a tool.
When you are finished and want to answer the user, reply with normal prose and no json block.

Available tools:
${spec}
`.trim();

  const out = [...messages];
  const firstSystem = out.findIndex((m) => m.role === 'system');
  if (firstSystem >= 0) out[firstSystem] = { ...out[firstSystem], content: `${out[firstSystem].content}\n\n${instruction}` };
  else out.unshift({ role: 'system', content: instruction });
  return out;
}

function parseJsonToolCalls(result) {
  if (result.toolCalls?.length) return result;
  const text = result.text || '';
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*"tool"[\s\S]*\})/);
  if (!match) return result;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!parsed.tool) return result;
    return {
      ...result,
      text: text.replace(match[0], '').trim(),
      toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name: parsed.tool, args: parsed.args || {} }],
    };
  } catch {
    return result;
  }
}

function safeParseArgs(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    // Some models emit trailing commas or single quotes; one salvage attempt.
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
    } catch {
      return { _unparsed: s };
    }
  }
}

export { ProviderError };
