import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { hiddenInput } from '../src/terminal.js';

test('secret prompt never echoes typed characters and restores terminal state', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true; input.isRaw = false;
  input.setRawMode = mode => { input.isRaw = mode; };
  let displayed = ''; output.on('data', b => { displayed += b.toString(); });
  const result = hiddenInput('Passphrase', input, output);
  input.emit('keypress', 'hidden-test-value', { name: 'text' });
  input.emit('keypress', undefined, { name: 'return' });
  assert.equal(await result, 'hidden-test-value');
  assert.equal(input.isRaw, false); assert.equal(displayed, 'Passphrase: \n');
});
test('cancelled prompt restores the terminal', async () => {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
  input.setRawMode = mode => { input.isRaw = mode; };
  const result = hiddenInput('Passphrase', input, output);
  input.emit('keypress', undefined, { ctrl: true, name: 'c' });
  await assert.rejects(result, /CANCELLED/); assert.equal(input.isRaw, false);
});
test('CLI is safe to start, refuses live commands and refuses secrets over a pipe', () => {
  for (const args of [['help'], ['sell'], ['buy'], ['flash'], ['wallet', 'create', 'buyer', 'buyer']]) {
    const child = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: new URL('..', import.meta.url), input: 'do-not-echo-this-value\n', encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, null);
    assert.equal((child.stdout + child.stderr).includes('do-not-echo-this-value'), false);
    if (args[0] === 'help') { assert.equal(child.status, 0); assert.match(child.stdout, /disabled/); }
    else { assert.equal(child.status, 1); assert.match(child.stderr, /DISABLED|INTERACTIVE_TERMINAL_REQUIRED/); }
  }
});
