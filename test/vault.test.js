import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync, statSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Vault } from '../src/vault.js';
const password = 'a long disposable test passphrase';
function fixture(t) { const root = mkdtempSync(path.join(os.tmpdir(), 'launcher-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return { root, vault: new Vault(root) }; }
test('wallets are encrypted, owner-only and authentication exposes only public metadata', async t => {
  const { root, vault } = fixture(t); const h = await vault.create('buyer-one', 'buyer', password);
  const payload = JSON.parse(readFileSync(path.join(root, 'buyer-one.vault')));
  assert.equal(payload.ciphertext.length, 44); assert.equal(Object.hasOwn(payload, 'seed'), false);
  assert.equal(statSync(path.join(root, 'buyer-one.vault')).mode & 0o777, 0o600);
  assert.equal((await vault.verifyPassword('buyer-one', password)).address, h.address);
  assert.equal((await vault.verifyPassword('buyer-one', password)).authenticated, true);
  assert.equal('unlock' in vault, false);
  assert.equal(Object.hasOwn(await vault.verifyPassword('buyer-one', password), 'keyPair'), false);
  assert.deepEqual(vault.list().map(w => w.id), ['buyer-one']);
});
test('wrong password fails authentication', async t => {
  const { vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  await assert.rejects(vault.verifyPassword('buyer', 'different long password'), /VAULT_AUTHENTICATION_FAILED/);
});
test('ciphertext and metadata tampering are rejected', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  const file = path.join(root, 'buyer.vault'), original = readFileSync(file, 'utf8');
  let payload = JSON.parse(original); payload.ciphertext = Buffer.alloc(32).toString('base64'); writeFileSync(file, JSON.stringify(payload));
  await assert.rejects(vault.verifyPassword('buyer', password), /VAULT_AUTHENTICATION_FAILED/);
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
test('create validates existing orphan and malformed manifests before writing a new wallet', async t => {
  const { root, vault } = fixture(t);
  writeFileSync(path.join(root, 'old.vault'), '{}', { mode: 0o600 });
  await assert.rejects(vault.create('new', 'buyer', password), /UNREGISTERED_WALLET/);
  assert.deepEqual(readdirSync(root), ['old.vault']);
  rmSync(path.join(root, 'old.vault'));
  writeFileSync(path.join(root, 'manifest.json'), '{"version":1,"wallets":[{"id":"../escape"}]}', { mode: 0o600 });
  await assert.rejects(vault.create('new', 'buyer', password));
  assert.deepEqual(readdirSync(root), ['manifest.json']);
});
test('vault root permission changes are rejected after construction', t => {
  const { root, vault } = fixture(t); chmodSync(root, 0o755);
  assert.throws(() => vault.list(), /UNSAFE_FILE_PERMISSIONS/);
  chmodSync(root, 0o700); assert.deepEqual(vault.list(), []);
  assert.throws(() => { vault.root = root + '-other'; });
});
test('a replaced vault directory is rejected before touching the replacement', t => {
  const { root, vault } = fixture(t), old = root + '-original';
  t.after(() => rmSync(old, { recursive: true, force: true }));
  renameSync(root, old); mkdirSync(root, { mode: 0o700 });
  assert.throws(() => vault.list(), /VAULT_DIRECTORY_REPLACED/);
  assert.deepEqual(readdirSync(root), []);
});
test('unexpected recovery/temp files block operations instead of being ignored', async t => {
  const { root, vault } = fixture(t);
  writeFileSync(path.join(root, 'manifest-interrupted.tmp'), '{}', { mode: 0o600 });
  assert.throws(() => vault.list(), /UNEXPECTED_VAULT_FILE/);
  await assert.rejects(vault.create('buyer', 'buyer', password), /UNEXPECTED_VAULT_FILE/);
});
test('failed authentication wipes both the derived key and unauthenticated plaintext buffer', async t => {
  const { root, vault } = fixture(t); await vault.create('buyer', 'buyer', password);
  const file = path.join(root, 'buyer.vault'), p = JSON.parse(readFileSync(file));
  p.tag = Buffer.alloc(16).toString('base64'); writeFileSync(file, JSON.stringify(p));
  const cleared = [], fill = Buffer.prototype.fill;
  t.mock.method(Buffer.prototype, 'fill', function(value, ...rest) {
    const result = fill.call(this, value, ...rest);
    if (value === 0 && this.length === 32) cleared.push(this);
    return result;
  });
  await assert.rejects(vault.verifyPassword('buyer', password), /VAULT_AUTHENTICATION_FAILED/);
  assert.ok(cleared.length >= 2);
  assert.ok(cleared.every(b => b.every(byte => byte === 0)));
});
test('wallet identifiers are strings, not coerced values', async t => {
  const { root, vault } = fixture(t);
  for (const id of [true, undefined, null, 123]) {
    await assert.rejects(vault.create(id, 'buyer', password), /INVALID_WALLET_ID_OR_ROLE/);
    await assert.rejects(vault.verifyPassword(id, password), /INVALID_WALLET_ID/);
  }
  assert.deepEqual(readdirSync(root), []);
});
test('vaults below non-sticky writable ancestors are rejected before creation', t => {
  const { root } = fixture(t); const shared = path.join(root, 'shared'); mkdirSync(shared); chmodSync(shared, 0o777);
  assert.throws(() => new Vault(path.join(shared, 'vault')), /UNSAFE_VAULT_ANCESTOR/);
  assert.deepEqual(readdirSync(shared), []);
});
test('ancestor permissions are rechecked on every vault operation', t => {
  const { root } = fixture(t); const parent = path.join(root, 'parent'); mkdirSync(parent, { mode: 0o700 });
  const vault = new Vault(path.join(parent, 'vault')); chmodSync(parent, 0o777);
  assert.throws(() => vault.list(), /UNSAFE_VAULT_ANCESTOR/);
  chmodSync(parent, 0o700); assert.deepEqual(vault.list(), []);
});
