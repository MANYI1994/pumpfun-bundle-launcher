import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Vault } from '../src/vault.js';
const password = 'a long disposable test passphrase';
function fixture(t) { const root = mkdtempSync(path.join(os.tmpdir(), 'launcher-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return { root, vault: new Vault(root) }; }
test('wallets are encrypted, owner-only and unlock to their recorded address', async t => {
  const { root, vault } = fixture(t); const h = await vault.create('buyer-one', 'buyer', password);
  const payload = JSON.parse(readFileSync(path.join(root, 'buyer-one.vault')));
  assert.equal(payload.ciphertext.length, 44); assert.equal(Object.hasOwn(payload, 'seed'), false);
  assert.equal(statSync(path.join(root, 'buyer-one.vault')).mode & 0o777, 0o600);
  assert.equal((await vault.unlock('buyer-one', password)).address, h.address);
  assert.equal((await vault.unlock('buyer-one', password)).keyPair.privateKey.extractable, false);
  assert.deepEqual(vault.list().map(w => w.id), ['buyer-one']);
});
test('wrong password fails authentication', async t => {
  const { vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  await assert.rejects(vault.unlock('buyer', 'different long password'), /VAULT_AUTHENTICATION_FAILED/);
});
test('ciphertext and metadata tampering are rejected', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  const file = path.join(root, 'buyer.vault'), original = readFileSync(file, 'utf8');
  let payload = JSON.parse(original); payload.ciphertext = Buffer.alloc(32).toString('base64'); writeFileSync(file, JSON.stringify(payload));
  await assert.rejects(vault.unlock('buyer', password), /VAULT_AUTHENTICATION_FAILED/);
  payload = JSON.parse(original); payload.header.role = 'payer'; writeFileSync(file, JSON.stringify(payload));
  assert.throws(() => vault.list(), /MANIFEST_MISMATCH/);
});
test('oversized or manipulated KDF parameters are rejected before derivation', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  const file = path.join(root, 'buyer.vault'), p = JSON.parse(readFileSync(file)); p.header.kdf.N = 2147483648; writeFileSync(file, JSON.stringify(p));
  assert.throws(() => vault.list(), /UNSUPPORTED_KDF/);
});
test('duplicate ids never overwrite keys', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  const before = readFileSync(path.join(root, 'buyer.vault'));
  await assert.rejects(vault.create('buyer', 'buyer', password), /WALLET_EXISTS/);
  assert.deepEqual(readFileSync(path.join(root, 'buyer.vault')), before);
});
test('orphan wallet files stop automatic selection', async t => {
  const { root, vault } = fixture(t); writeFileSync(path.join(root, 'old.vault'), '{}', { mode: 0o600 });
  assert.throws(() => vault.list(), /UNREGISTERED_WALLET/);
});
test('symlinks, loose permissions, directory traversal and locks are rejected', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  chmodSync(path.join(root, 'buyer.vault'), 0o644); assert.throws(() => vault.list(), /UNSAFE_FILE_PERMISSIONS/);
  chmodSync(path.join(root, 'buyer.vault'), 0o600);
  await assert.rejects(vault.create('../escape', 'buyer', password), /INVALID_WALLET/);
  writeFileSync(path.join(root, '.lock'), 'held', { mode: 0o600 }); assert.throws(() => vault.list(), /VAULT_BUSY/);
  rmSync(path.join(root, '.lock'));
  const outside = path.join(root, 'link'); symlinkSync(path.join(root, 'buyer.vault'), outside);
  assert.throws(() => new Vault(outside), /SYMLINK_NOT_ALLOWED/);
  assert.ok(readdirSync(root).includes('buyer.vault'));
});
test('short passwords rejected without writing secrets', async t => {
  const { root, vault } = fixture(t); await assert.rejects(vault.create('buyer', 'buyer', 'short'), /PASSPHRASE/);
  assert.deepEqual(readdirSync(root), []);
});
