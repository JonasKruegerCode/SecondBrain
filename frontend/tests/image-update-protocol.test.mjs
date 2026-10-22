import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function exchange(commands) {
  const child = spawn(process.execPath, ['e2e/image-update.mjs'], {
    cwd: new URL('../', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', diagnostics = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    child.stdin.end(commands.map(value => JSON.stringify(value)).join('\n') + '\n');
    const exit = await finished;
    return { ...exit, records: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), diagnostics };
  } finally { clearTimeout(timer); }
}

test('real stdin handshake and graceful close retain one response per command', async () => {
  const result = await exchange([{ command: 'ready' }, { command: 'close' }]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.records, [{ ok: true, phase: 'ready' }, { ok: true, phase: 'closed' }]);
  assert.match(result.diagnostics, /"phase":"protocol-ready"/);
});

test('invalid upstream returns a bounded failure with the original gate', async () => {
  const result = await exchange([{ command: 'ready' }, { command: 'baseline', upstream: 'https://example.invalid/' }]);
  assert.equal(result.code, 1);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].ok, false);
  assert.equal(result.records[1].gate, 'baseline-upstream');
  assert.match(result.diagnostics, /"phase":"baseline-upstream"/);
});
