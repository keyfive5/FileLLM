// Exercises the real agent loop — real tools, real files, real fixture, real
// grader — against a scripted model. This separates two things that are easy to
// confuse:
//
//   * Does the loop work?          <- this file, deterministic, no model needed
//   * Can a given model do it?     <- test/probe-agentturn.mjs, against a live model
//
// The scripted model only decides *which* tool to call. Every path, size and
// snippet in the transcript still comes from the real filesystem, so a broken
// tool, a broken result hand-back, or a broken multi-turn history fails here.
//
// Run: node test/loop.test.mjs

import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.mjs';
import { buildFixture, cleanupFixture, grade } from '../src/selftest.mjs';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.stack?.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

const cfg = { provider: 'mock', model: 'scripted-1', temperature: 0 };

/** A model that plays a fixed sequence of turns and records what it was shown. */
function scriptedModel(turns) {
  const seen = [];
  let i = 0;
  const fn = async ({ messages }) => {
    seen.push(messages.map((m) => ({ role: m.role, name: m.name, content: m.content, toolCalls: m.toolCalls })));
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const resolved = typeof turn === 'function' ? turn(messages) : turn;
    return {
      text: resolved.text || '',
      toolCalls: (resolved.toolCalls || []).map((tc, n) => ({ id: `call_${i}_${n}`, name: tc.name, args: tc.args })),
      usage: { in: 100, out: 20 },
      stopReason: resolved.toolCalls?.length ? 'tool_calls' : 'stop',
      model: 'scripted-1',
    };
  };
  fn.seen = seen;
  fn.turnsUsed = () => i;
  return fn;
}

console.log('\nagent loop');

await t('runs the full find-the-token task through the real loop and passes the grader', async () => {
  const fx = await buildFixture();
  try {
    // Turn 1: search the whole folder for the token, restricted to 2018.
    // Turn 2: read the transcript and answer. The filename is NOT scripted —
    // it is copied out of whatever search_content actually returned.
    const model = scriptedModel([
      { text: 'I will search inside the documents for that code, filtered to 2018.', toolCalls: [{ name: 'search_content', args: { path: fx.dir, query: fx.token, modified: '2018' } }] },
      (messages) => {
        const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
        const hit = /### `([^`]+)`/.exec(toolMsg?.content || '');
        return { text: hit ? `The document is ${hit[1].split('\\').pop()}, at ${hit[1]}.` : 'I could not find it.' };
      },
    ]);

    const events = [];
    const result = await runAgent({
      userMessage: fx.prompt,
      cfg,
      emit: (e) => events.push(e),
      chatFn: model,
    });

    const report = grade(fx, result);
    assert.equal(report.verdict, 'PASS', `grader said FAIL:\n${JSON.stringify(report.checks, null, 2)}\nfinal: ${result.finalText}`);

    // The loop must have actually fed the tool result back for turn 2 to work.
    assert.equal(model.turnsUsed(), 2, 'expected exactly two model turns');
    assert.ok(result.finalText.includes(fx.target.name), `answer did not name the target: ${result.finalText}`);
    assert.ok(!result.finalText.includes(fx.trap.name), `answer leaked the trap: ${result.finalText}`);

    // ...and the events the UI renders must describe what happened.
    const types = events.map((e) => e.type);
    for (const required of ['run_start', 'tool_call', 'tool_result', 'final', 'run_end']) {
      assert.ok(types.includes(required), `no ${required} event emitted (got ${[...new Set(types)].join(', ')})`);
    }
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.equal(toolResult.ok, true, toolResult.content);
    assert.ok(toolResult.content.includes(fx.target.name), 'tool result did not contain the real filename');
  } finally {
    await cleanupFixture(fx.dir);
  }
});

await t('feeds each tool result back to the next turn', async () => {
  const model = scriptedModel([
    { toolCalls: [{ name: 'disk_overview', args: {} }] },
    { toolCalls: [{ name: 'list_directory', args: { path: process.env.LOCALAPPDATA } }] },
    { text: 'done' },
  ]);
  await runAgent({ userMessage: 'look around', cfg, emit: () => {}, chatFn: model });

  const secondTurn = model.seen[1];
  assert.equal(secondTurn.at(-1).role, 'tool', 'the tool result was not appended before the next turn');
  assert.ok(secondTurn.at(-1).content.includes('Drives'), 'the disk_overview output never reached the model');

  const thirdTurn = model.seen[2];
  assert.equal(thirdTurn.filter((m) => m.role === 'tool').length, 2, 'earlier tool results were dropped from history');
});

await t('a tool error is reported to the model instead of killing the run', async () => {
  const model = scriptedModel([
    { toolCalls: [{ name: 'read_file', args: { path: 'Z:\\definitely\\missing\\file.txt' } }] },
    { text: 'That path does not exist.' },
  ]);
  const events = [];
  const result = await runAgent({ userMessage: 'read it', cfg, emit: (e) => events.push(e), chatFn: model });

  assert.equal(result.finalText, 'That path does not exist.');
  const toolMsg = model.seen[1].at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.ok(/could not|failed|no such|not exist/i.test(toolMsg.content), `unhelpful error text: ${toolMsg.content}`);
});

await t('an unknown tool name is handled gracefully', async () => {
  const model = scriptedModel([{ toolCalls: [{ name: 'rm_rf_everything', args: {} }] }, { text: 'ok, that tool does not exist' }]);
  const events = [];
  const result = await runAgent({ userMessage: 'go', cfg, emit: (e) => events.push(e), chatFn: model });

  const toolResult = events.find((e) => e.type === 'tool_result');
  assert.equal(toolResult.ok, false);
  assert.ok(toolResult.content.includes('No such tool'), toolResult.content);
  assert.equal(result.finalText, 'ok, that tool does not exist');
});

await t('stops at the step limit instead of looping forever', async () => {
  // A model that only ever calls tools and never answers.
  const model = scriptedModel([{ toolCalls: [{ name: 'disk_overview', args: {} }] }]);
  const events = [];
  const result = await runAgent({ userMessage: 'go', cfg, emit: (e) => events.push(e), chatFn: model });

  const runEnd = events.find((e) => e.type === 'run_end');
  assert.ok(runEnd.steps <= 14, `ran ${runEnd.steps} steps`);
  assert.ok(/step limit/i.test(result.finalText), result.finalText);
});

await t('a model failure surfaces as an error event, not a crash', async () => {
  const model = async () => {
    throw new Error('provider exploded');
  };
  const events = [];
  const result = await runAgent({ userMessage: 'go', cfg, emit: (e) => events.push(e), chatFn: model });

  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'no error event emitted');
  assert.ok(err.message.includes('provider exploded'));
  assert.ok(events.some((e) => e.type === 'run_end'), 'run_end must still fire so the UI unblocks');
  assert.equal(result.finalText, '');
});

await t('cancellation leaves a history the next turn can still use', async () => {
  const ac = new AbortController();
  const model = scriptedModel([
    () => {
      ac.abort(new Error('user cancelled'));
      return { toolCalls: [{ name: 'disk_overview', args: {} }] };
    },
    { text: 'should not get here' },
  ]);
  const result = await runAgent({ userMessage: 'go', cfg, emit: () => {}, signal: ac.signal, chatFn: model });

  const dangling = result.history.filter((m) => m.role === 'assistant' && m.toolCalls?.length);
  for (const m of dangling) {
    for (const tc of m.toolCalls) {
      assert.ok(
        result.history.some((x) => x.role === 'tool' && x.toolCallId === tc.id),
        `history kept an unanswered tool call (${tc.name}) — the next request would be rejected`
      );
    }
  }
});

await t('propose_changes reaches the approval queue without touching disk', async () => {
  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FileLLM', 'looptest');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const victim = path.join(dir, 'junk.tmp');
  await fsp.writeFile(victim, 'x'.repeat(1000));

  const model = scriptedModel([
    { toolCalls: [{ name: 'propose_changes', args: { summary: 'clear a temp file', operations: [{ action: 'recycle', path: victim, reason: 'temp file' }] } }] },
    { text: 'I have staged that for your approval.' },
  ]);
  const events = [];
  await runAgent({ userMessage: 'clean up', cfg, emit: (e) => events.push(e), chatFn: model });

  assert.equal(fs.existsSync(victim), true, 'the agent loop deleted a file without approval');
  const { listPlans, discardPlan } = await import('../src/tools/mutate.mjs');
  const plan = listPlans().find((p) => p.summary === 'clear a temp file');
  assert.ok(plan, 'the plan never reached the approval queue');
  assert.equal(plan.operations[0].bytes, 1000);
  discardPlan(plan.id);

  await fsp.rm(dir, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
