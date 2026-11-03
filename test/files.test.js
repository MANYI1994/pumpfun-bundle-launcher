import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readRegularFile } from '../src/files.js';
test('bounded file reads reject oversized, malformed UTF-8, directories and symlinks', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launcher-files-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data');
  writeFileSync(file, '12345', { mode: 0o600 }); assert.throws(() => readRegularFile(file, { maxBytes: 4 }), /INVALID_OR_OVERSIZED/);
  writeFileSync(file, Buffer.from([0xff])); assert.throws(() => readRegularFile(file), /INVALID_UTF8/);
  symlinkSync(file, path.join(root, 'link')); assert.throws(() => readRegularFile(path.join(root, 'link')));
  assert.throws(() => readRegularFile(root), /INVALID_OR_OVERSIZED/);
});
test('a FIFO is rejected without waiting for a writer', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launcher-fifo-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'import {readRegularFile} from "./src/files.js"; try { readRegularFile(process.argv[1]); process.exit(2); } catch { process.exit(0); }', fifo], { cwd: new URL('..', import.meta.url), timeout: 3000 });
  assert.equal(child.signal, null); assert.equal(child.status, 0);
});
