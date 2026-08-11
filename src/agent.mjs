// The agent loop.
//
// This is a real ReAct-style loop, not a template: the model decides which tool
// to call and with what arguments, sees the result, and decides again. Every
// decision point is emitted as an event so the UI can show the reasoning as it
// happens rather than after the fact.

import os from 'node:os';
import path from 'node:path';
import { chat } from './providers.mjs';
import { TOOLS, TOOL_MAP, toolSchemas } from './tools/index.mjs';
import { listDrives, HOME_DIR, defaultRoots } from './safety.mjs';
import { humanBytes, capText, shortId } from './util.mjs';

const MAX_STEPS = 14;

function buildSystemPrompt() {
  const drives = listDrives()
    .map((d) => `${d.path} (${d.free != null ? `${humanBytes(d.free)} free of ${humanBytes(d.total)}` : 'size unknown'})`)
    .join(', ');

  return `You are FileLLM, an agent that manages files on this Windows machine.

## This machine
- User home: ${HOME_DIR}
- Drives: ${drives || 'none detected'}
- Common folders: ${defaultRoots().join(', ') || 'none found'}
- Today: ${new Date().toISOString().slice(0, 10)}
- Path separator is backslash. In JSON arguments write it escaped: "C:\\\\Users\\\\Name\\\\Documents".

## How to work
You have tools that read the filesystem directly. Use them. Never guess at file
names, sizes or dates — call a tool and report what actually came back.

Work in small verified steps:
1. Start broad and cheap (disk_overview, list_directory) before anything expensive.
2. Narrow with filters before opening file contents. search_content reads every
   candidate file, so always pass extensions and/or a date filter when you can.
3. If a tool returns nothing useful, change the approach rather than repeating
   the same call. Widen the path, drop a filter, or try include_noise: true.
4. Cite real paths and real sizes in your answer.

## Changing files
You cannot delete, move or rename anything yourself. propose_changes stages a
plan that the user sees and approves in the UI; it is the only way changes ever
happen, and it is deliberately a one-way handoff.

Before proposing to remove anything:
- Confirm what it is. Use read_file or find_files rather than assuming from a name.
- Give a per-operation \`reason\` the user can judge. "Cache, regenerates automatically"
  is useful. "Not needed" is not.
- Never propose to remove something you have not measured or inspected.
- Prefer 'move' to a review folder over 'recycle' when you are not certain.
- Deleted items go to the Recycle Bin, but say so rather than implying it is permanent.

After calling propose_changes, stop and explain the plan in prose. Do not call it
again for the same plan and do not claim anything has been deleted — it has not.

## Answering
Be concrete and brief. Lead with the answer, then the evidence. Use tables for
lists of files. When you report a size, give the human-readable form.
If the honest answer is "there is nothing large enough to matter here", say that.`;
}

/**
 * Run one user turn to completion.
 *
 * @param {object} opts
 * @param {Array}  opts.history      prior messages in internal format
 * @param {string} opts.userMessage
 * @param {object} opts.cfg          provider config
 * @param {(event:object)=>void} opts.emit
 * @param {AbortSignal} opts.signal
 */
export async function runAgent({ history = [], userMessage, cfg, emit, signal }) {
  const runId = shortId('run_');
  const started = Date.now();

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const trace = {
    runId,
    startedAt: started,
    provider: cfg.provider,
    model: cfg.model,
    steps: [],
    http: [],
    usage: { in: 0, out: 0 },
  };

  const isCancelled = () => signal?.aborted === true;
  const onHttp = (record) => {
    trace.http.push(record);
    emit({ type: 'http', runId, record });
  };

  emit({ type: 'run_start', runId, provider: cfg.provider, model: cfg.model, toolCount: TOOLS.length, at: started });

  let toolMode = cfg.toolMode || 'native';
  let finalText = '';
  let step = 0;

  try {
    while (step < MAX_STEPS) {
      if (isCancelled()) {
        emit({ type: 'cancelled', runId });
        break;
      }
      step++;
      emit({ type: 'step_start', runId, step });

      let res;
      try {
        res = await chat({
          cfg: { ...cfg, toolMode },
          messages,
          tools: toolSchemas(),
          onHttp,
          signal,
          onSlow: (budget) =>
            emit({
              type: 'notice',
              runId,
              message: `Still waiting on ${cfg.provider} — local models on CPU can take a minute or more per step. Giving it up to ${budget}s.`,
            }),
        });
      } catch (err) {
        // Providers that lack native tool calling fail loudly and specifically;
        // retry once over the plain-text protocol instead of giving up.
        if (toolMode === 'native' && /tool|function/i.test(err.message) && /support|invalid|unknown|not.*allow/i.test(err.message)) {
          emit({ type: 'notice', runId, message: 'This model does not support native tool calling — switching to the JSON tool protocol.' });
          toolMode = 'json';
          step--;
          continue;
        }
        throw err;
      }

      trace.usage.in += res.usage?.in || 0;
      trace.usage.out += res.usage?.out || 0;

      const stepRecord = {
        step,
        thought: res.text || '',
        toolCalls: res.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
        usage: res.usage,
        stopReason: res.stopReason,
      };

      if (res.text) emit({ type: 'assistant_text', runId, step, text: res.text });

      if (!res.toolCalls.length) {
        finalText = res.text || '(the model returned an empty response)';
        trace.steps.push({ ...stepRecord, final: true });
        messages.push({ role: 'assistant', content: finalText });
        emit({ type: 'final', runId, step, text: finalText });
        break;
      }

      messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });

      const results = [];
      for (const call of res.toolCalls) {
        if (isCancelled()) break;

        const tool = TOOL_MAP.get(call.name);
        emit({ type: 'tool_call', runId, step, id: call.id, name: call.name, args: call.args, mutating: !!tool?.mutating });

        const t0 = Date.now();
        let output;
        let ok = true;

        if (!tool) {
          ok = false;
          output = `No such tool: "${call.name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
        } else {
          try {
            const ctx = {
              isCancelled,
              progress: (msg) => emit({ type: 'tool_progress', runId, step, id: call.id, name: call.name, message: msg }),
              emit: (kind, payload) => emit({ type: kind, runId, step, payload }),
            };
            const result = await tool.handler(call.args || {}, ctx);
            output = capText(typeof result === 'string' ? result : result.content, 14000);
            emit({
              type: 'tool_result',
              runId,
              step,
              id: call.id,
              name: call.name,
              ms: Date.now() - t0,
              ok: true,
              content: output,
              data: result?.data ?? null,
            });
          } catch (err) {
            ok = false;
            output = `Tool "${call.name}" failed: ${err.message}`;
            emit({ type: 'tool_result', runId, step, id: call.id, name: call.name, ms: Date.now() - t0, ok: false, content: output });
          }
        }

        if (!ok && !tool) {
          emit({ type: 'tool_result', runId, step, id: call.id, name: call.name, ms: Date.now() - t0, ok: false, content: output });
        }

        results.push({ call, output, ok, ms: Date.now() - t0 });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output });
      }

      stepRecord.results = results.map((r) => ({ name: r.call.name, ok: r.ok, ms: r.ms, preview: r.output.slice(0, 400) }));
      trace.steps.push(stepRecord);
    }

    if (!finalText && step >= MAX_STEPS) {
      finalText = `I hit the ${MAX_STEPS}-step limit for one turn. Here is where I got to — ask me to continue and I will pick up from here.`;
      emit({ type: 'final', runId, step, text: finalText, truncated: true });
      messages.push({ role: 'assistant', content: finalText });
    }
  } catch (err) {
    emit({ type: 'error', runId, message: err.message, detail: err.body ?? null });
    trace.error = err.message;
    finalText = '';
  }

  trace.finishedAt = Date.now();
  trace.durationMs = trace.finishedAt - started;
  trace.stepCount = step;
  emit({ type: 'run_end', runId, durationMs: trace.durationMs, steps: step, usage: trace.usage, httpCalls: trace.http.length });

  // Strip the system prompt back out — it is rebuilt fresh each turn.
  const newHistory = messages.filter((m) => m.role !== 'system');
  return { runId, finalText, trace, history: newHistory };
}

export { MAX_STEPS, buildSystemPrompt };
