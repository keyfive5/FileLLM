// Times the exact first turn the agent sends, through the real provider stack,
// so the number reflects what a user would actually experience.
//
// Usage: node test/probe-agentturn.mjs [model] [provider]
import { buildSystemPrompt } from '../src/agent.mjs';
import { toolSchemas } from '../src/tools/index.mjs';
import { chat, PROVIDERS } from '../src/providers.mjs';

const model = process.argv[2] || 'qwen3:4b';
const provider = process.argv[3] || 'ollama';

const system = buildSystemPrompt();
const user =
  'Somewhere under C:\\Temp\\case_1 there is a document last modified in 2018 that contains the reference code ' +
  'ZPHR-ABCDEF123456. Find it and tell me its exact filename and full path. Be careful: more than one file mentions ' +
  'that code, so make sure the one you report is the 2018 one. Do not change any files.';

const tools = toolSchemas();
console.log(`provider=${provider} model=${model}`);
console.log(`system chars=${system.length}  tools bytes=${JSON.stringify(tools).length}`);

const t0 = Date.now();
try {
  const res = await chat({
    cfg: {
      provider,
      model,
      baseUrl: PROVIDERS[provider].baseUrl,
      apiKey: process.env.FILELLM_KEY || '',
      temperature: 0.2,
      timeoutMs: 1800000,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools,
    onHttp: (r) => console.log(`  http ${r.status} in ${(r.ms / 1000).toFixed(1)}s`),
    onSlow: (b) => console.log(`  (still waiting, budget ${b}s)`),
  });
  console.log(`elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('usage:', JSON.stringify(res.usage));
  console.log('tool_calls:', JSON.stringify(res.toolCalls));
  console.log('text:', (res.text || '').slice(0, 200));
} catch (e) {
  console.log(`elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s FAILED: ${e.message}`);
}
