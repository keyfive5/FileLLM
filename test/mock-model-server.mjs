// A tiny OpenAI-compatible "model" that solves exactly the self-test task.
//
// Point FileLLM at it to exercise the entire real pipeline — HTTP, the agent
// loop, the tools, the SSE stream and the UI rendering — with no model, no
// API key and no waiting. Useful for developing the UI and for checking that a
// failure is in FileLLM rather than in whatever model you configured.
//
//   node test/mock-model-server.mjs           # listens on 8899
//   then set provider=lmstudio, baseUrl=http://127.0.0.1:8899/v1
//
// It is deliberately dumb: it reads the prompt, calls one search, then reports
// whatever the tool actually found. Every path it prints comes from your disk.

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 8899;

function reply(res, message, promptTokens = 1200) {
  const body = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-scripted-1',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 },
  };
  const json = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('{"error":{"message":"bad json"}}');
      return;
    }

    const messages = payload.messages || [];
    const user = messages.find((m) => m.role === 'user')?.content || '';
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

    console.log(`  <- turn with ${messages.length} messages, ${payload.tools?.length ?? 0} tools offered`);

    // Second turn: answer from whatever the tool actually returned.
    if (lastTool) {
      const hit = /### `([^`]+)`/.exec(lastTool.content || '');
      const text = hit
        ? `Found it. The 2018 document containing that code is **${hit[1].split('\\').pop()}**\n\nFull path: \`${hit[1]}\`\n\nI searched inside the documents rather than by filename, and filtered to files modified in 2018, which excluded the other file that mentions the same code.`
        : `I could not find a matching document. The search returned:\n\n${(lastTool.content || '').slice(0, 300)}`;
      console.log(`  -> answering: ${hit ? hit[1] : 'not found'}`);
      return reply(res, { role: 'assistant', content: text });
    }

    // Lets you exercise the approval panel without a real model:
    //   "stage a test plan for C:\some\file.txt"
    const stage = /^stage a test plan for (.+)$/i.exec(user.trim());
    if (stage) {
      console.log(`  -> calling propose_changes(recycle ${stage[1]})`);
      return reply(res, {
        role: 'assistant',
        content: 'Staging that for your approval.',
        tool_calls: [
          {
            id: 'call_mock_plan',
            type: 'function',
            function: {
              name: 'propose_changes',
              arguments: JSON.stringify({
                summary: 'Remove one test file',
                operations: [{ action: 'recycle', path: stage[1], reason: 'Created by the FileLLM mock model for UI testing' }],
              }),
            },
          },
        ],
      });
    }

    // First turn: read the task out of the prompt and pick a tool.
    const m = /under (.+?) there is a document last modified in (\d{4}) that contains the reference code (\S+?)\./i.exec(user);
    if (!m) {
      console.log('  -> prompt not recognised, answering directly');
      return reply(res, { role: 'assistant', content: 'I only know how to run the FileLLM self-test task.' });
    }
    const [, dir, year, token] = m;
    console.log(`  -> calling search_content(path=${dir}, query=${token}, modified=${year})`);
    return reply(res, {
      role: 'assistant',
      content: 'I will search inside the documents for that code and filter to that year.',
      tool_calls: [
        {
          id: 'call_mock_1',
          type: 'function',
          function: { name: 'search_content', arguments: JSON.stringify({ path: dir, query: token, modified: year }) },
        },
      ],
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock model listening on http://127.0.0.1:${PORT}/v1`);
  console.log('point FileLLM at it: provider=lmstudio, baseUrl=http://127.0.0.1:' + PORT + '/v1');
});
