// Does disabling qwen3's thinking mode cut the latency, and does tool calling survive?
import { toolSchemas } from '../src/tools/index.mjs';

const tools = toolSchemas().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
const messages = [
  { role: 'system', content: 'You are a file agent. Use tools to answer.' },
  { role: 'user', content: 'How much free space is on this machine?' },
];

async function run(label, url, body) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout-150s')), 150000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    const j = await res.json();
    const msg = j.choices?.[0]?.message || j.message || {};
    const calls = msg.tool_calls;
    console.log(
      `${label.padEnd(28)} ${String(Date.now() - t0).padStart(7)}ms  status=${res.status}  ` +
        `tools=${calls ? calls.map((c) => c.function?.name).join(',') : 'NONE'}  ` +
        `out_tokens=${j.usage?.completion_tokens ?? j.eval_count ?? '?'}`
    );
    if (!calls) console.log('   content:', (msg.content || JSON.stringify(j).slice(0, 200)).slice(0, 200));
  } catch (e) {
    console.log(`${label.padEnd(28)} ${String(Date.now() - t0).padStart(7)}ms  FAILED: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

await run('v1 + think:false', 'http://127.0.0.1:11434/v1/chat/completions', {
  model: 'qwen3:4b', messages, tools, temperature: 0.2, think: false,
});

await run('v1 + chat_template_kwargs', 'http://127.0.0.1:11434/v1/chat/completions', {
  model: 'qwen3:4b', messages, tools, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
});

await run('native /api/chat think:false', 'http://127.0.0.1:11434/api/chat', {
  model: 'qwen3:4b', messages, tools, think: false, stream: false, options: { temperature: 0.2 },
});

await run('v1 + /no_think in system', 'http://127.0.0.1:11434/v1/chat/completions', {
  model: 'qwen3:4b',
  messages: [{ role: 'system', content: 'You are a file agent. Use tools to answer. /no_think' }, messages[1]],
  tools,
  temperature: 0.2,
});
