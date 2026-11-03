import { constants, openSync, closeSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, readdirSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { canonical, exactKeys, requireSafe, SafetyError, validAddress } from './security.js';
import { readRegularFile } from './files.js';

const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const ID = /^[a-z][a-z0-9-]{0,47}$/;
function privateStat(stat) {
  requireSafe(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'UNSAFE_FILE_PERMISSIONS');
}
export function prepareRoot(root) {
  requireSafe(typeof root === 'string' && path.isAbsolute(root), 'ABSOLUTE_VAULT_PATH_REQUIRED');
  requireSafe(path.normalize(root) === root, 'NORMALIZED_VAULT_PATH_REQUIRED');
  // Resolve existing ancestors and reject symlinks before creating the root.
  let part = path.parse(root).root;
  for (const component of root.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, component);
    try { requireSafe(!lstatSync(part).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; mkdirSync(part, { mode: 0o700 }); }
  }
  const stat = lstatSync(root); requireSafe(stat.isDirectory(), 'INVALID_VAULT_DIRECTORY'); privateStat(stat);
  return realpathSync(root);
}
function readPrivate(file, limit = 65536) {
  return readRegularFile(file, { maxBytes: limit, privateFile: true });
}
function exclusiveWrite(file, data) {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function lock(root, assertRoot, fn) {
  assertRoot();
  const file = path.join(root, '.lock');
  try { exclusiveWrite(file, 'locked\n'); } catch (e) { if (e.code === 'EEXIST') throw new SafetyError('VAULT_BUSY'); throw e; }
  const identity = lstatSync(file, { bigint: true });
  try { assertRoot(); return fn(); }
  finally {
    assertRoot();
    const current = lstatSync(file, { bigint: true });
    requireSafe(current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink(), 'VAULT_LOCK_REPLACED');
    unlinkSync(file);
  }
}
function syncDirectory(root) {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function key(password, salt) {
  requireSafe(typeof password === 'string' && password.length >= 16 && password.length <= 1024, 'PASSPHRASE_MINIMUM_16_CHARACTERS');
  return scryptSync(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
}
function b64(s, size) {
  requireSafe(typeof s === 'string' && Buffer.from(s, 'base64').toString('base64') === s && Buffer.from(s, 'base64').length === size, 'INVALID_VAULT_ENCODING');
  return Buffer.from(s, 'base64');
}
function validateHeader(header) {
  exactKeys(header, ['version', 'id', 'role', 'address', 'kdf']);
  requireSafe(header.version === 1 && typeof header.id === 'string' && ID.test(header.id) && ['buyer', 'payer', 'deployer', 'mint'].includes(header.role), 'INVALID_VAULT_HEADER');
  validAddress(header.address);
  requireSafe(canonical(header.kdf) === canonical(KDF), 'UNSUPPORTED_KDF');
}
export class Vault {
  #root; #identity;
  constructor(root) {
    requireSafe(process.platform === 'linux' && typeof process.getuid === 'function', 'LINUX_REQUIRED_FOR_SECURE_VAULT');
    this.#root = prepareRoot(root);
    this.#identity = lstatSync(this.#root, { bigint: true });
  }
  get root() { return this.#root; }
  #assertRoot = () => {
    let part = path.parse(this.#root).root;
    for (const component of this.#root.slice(part.length).split(path.sep).filter(Boolean)) {
      part = path.join(part, component);
      requireSafe(!lstatSync(part).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
    }
    const stat = lstatSync(this.#root, { bigint: true });
    requireSafe(stat.isDirectory() && stat.dev === this.#identity.dev && stat.ino === this.#identity.ino, 'VAULT_DIRECTORY_REPLACED');
    requireSafe(stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n, 'UNSAFE_FILE_PERMISSIONS');
  };
  #inventory() {
      const manifestPath = path.join(this.root, 'manifest.json');
      let manifest;
      try { manifest = JSON.parse(readPrivate(manifestPath)); }
      catch (e) { if (e.code === 'ENOENT') manifest = { version: 1, wallets: [] }; else throw e; }
      exactKeys(manifest, ['version', 'wallets']);
      requireSafe(manifest.version === 1 && Array.isArray(manifest.wallets) && manifest.wallets.length <= 24, 'INVALID_MANIFEST');
      const ids = new Set(), addresses = new Set();
      for (const h of manifest.wallets) {
        validateHeader(h); requireSafe(!ids.has(h.id) && !addresses.has(h.address), 'DUPLICATE_WALLET'); ids.add(h.id); addresses.add(h.address);
        const stored = JSON.parse(readPrivate(path.join(this.root, h.id + '.vault')));
        exactKeys(stored, ['header', 'salt', 'iv', 'tag', 'ciphertext']);
        validateHeader(stored.header);
        requireSafe(canonical(stored.header) === canonical(h), 'MANIFEST_MISMATCH');
        b64(stored.salt, 32); b64(stored.iv, 12); b64(stored.tag, 16); b64(stored.ciphertext, 32);
      }
      const expected = new Set(manifest.wallets.map(h => h.id + '.vault'));
      for (const file of readdirSync(this.root)) {
        if (file.endsWith('.vault')) requireSafe(expected.has(file), 'UNREGISTERED_WALLET');
        else requireSafe(['manifest.json', '.lock'].includes(file), 'UNEXPECTED_VAULT_FILE');
      }
      return structuredClone(manifest.wallets);
  }
  list() {
    return lock(this.root, this.#assertRoot, () => this.#inventory());
  }
  async create(id, role, password) {
    requireSafe(typeof id === 'string' && ID.test(id) && ['buyer', 'payer', 'deployer', 'mint'].includes(role), 'INVALID_WALLET_ID_OR_ROLE');
    const seed = randomBytes(32);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      const header = { version: 1, id, role, address: signer.address, kdf: KDF };
      const salt = randomBytes(32), iv = randomBytes(12), derived = key(password, salt);
      let encrypted, tag;
      try { const c = createCipheriv('aes-256-gcm', derived, iv); c.setAAD(Buffer.from(canonical(header))); encrypted = Buffer.concat([c.update(seed), c.final()]); tag = c.getAuthTag(); }
      finally { derived.fill(0); }
      // No overwrite, including stale/unregistered wallets.
      lock(this.root, this.#assertRoot, () => {
        const manifest = { version: 1, wallets: this.#inventory() };
        requireSafe(manifest.wallets.length < 24, 'WALLET_LIMIT');
        requireSafe(!manifest.wallets.some(w => w.id === id || w.address === header.address), 'WALLET_EXISTS');
        const payload = { header, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: encrypted.toString('base64') };
        exclusiveWrite(path.join(this.root, id + '.vault'), canonical(payload));
        syncDirectory(this.root);
        manifest.wallets.push(header);
        const tmp = path.join(this.root, 'manifest-' + randomBytes(12).toString('hex') + '.tmp');
        exclusiveWrite(tmp, canonical(manifest)); renameSync(tmp, path.join(this.root, 'manifest.json'));
        syncDirectory(this.root);
      });
      return header;
    } finally { seed.fill(0); }
  }
  async unlock(id, password) {
    requireSafe(typeof id === 'string' && ID.test(id), 'INVALID_WALLET_ID');
    const h = this.list().find(w => w.id === id); requireSafe(h, 'WALLET_NOT_REGISTERED');
    const payload = JSON.parse(readPrivate(path.join(this.root, id + '.vault')));
    exactKeys(payload, ['header', 'salt', 'iv', 'tag', 'ciphertext']); validateHeader(payload.header);
    requireSafe(canonical(payload.header) === canonical(h), 'MANIFEST_MISMATCH');
    const derived = key(password, b64(payload.salt, 32)); let seed, partial, final;
    try {
      const c = createDecipheriv('aes-256-gcm', derived, b64(payload.iv, 12)); c.setAAD(Buffer.from(canonical(h))); c.setAuthTag(b64(payload.tag, 16));
      // Keep unauthenticated plaintext reachable for wiping even when final() throws.
      partial = c.update(b64(payload.ciphertext, 32)); final = c.final();
      seed = Buffer.concat([partial, final]);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      requireSafe(signer.address === h.address, 'KEY_ADDRESS_MISMATCH');
      return signer;
    } catch { throw new SafetyError('VAULT_AUTHENTICATION_FAILED'); }
    finally { derived.fill(0); partial?.fill(0); final?.fill(0); seed?.fill(0); }
  }
}
