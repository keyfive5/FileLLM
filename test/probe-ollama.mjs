// Ad-hoc latency probe: how long does one tool-calling turn take on this box?
import { toolSchemas } from '../src/tools/index.mjs';

const model = process.argv[2] || 'qwen3:4b';
const tools = toolSchemas().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

const body = {
  model,
  messages: [
    { role: 'system', content: 'You are a file agent. Use tools to answer.' },
    { role: 'user', content: 'How much free space is on this machine?' },
  ],
  tools,
  tool_choice: 'auto',
  temperature: 0.2,
};

console.log('model:', model);
console.log('tool schema bytes:', JSON.stringify(tools).length);

const t0 = Date.now();
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error('hard-timeout-150s')), 150000);
try {
  const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  const j = await res.json();
  console.log('elapsed ms:', Date.now() - t0, 'status:', res.status);
  console.log('tool_calls:', JSON.stringify(j.choices?.[0]?.message?.tool_calls));
  console.log('content:', (j.choices?.[0]?.message?.content || '').slice(0, 200));
  console.log('usage:', JSON.stringify(j.usage));
} catch (e) {
  console.log('elapsed ms:', Date.now() - t0, 'FAILED:', e.message);
} finally {
  clearTimeout(timer);
}
