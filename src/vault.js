import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, readdirSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { canonical, exactKeys, requireSafe, SafetyError, validAddress } from './security.js';

const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const ID = /^[a-z][a-z0-9-]{0,47}$/;
function privateStat(stat) {
  requireSafe(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'UNSAFE_FILE_PERMISSIONS');
}
export function prepareRoot(root) {
  requireSafe(typeof root === 'string' && path.isAbsolute(root), 'ABSOLUTE_VAULT_PATH_REQUIRED');
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
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); privateStat(stat);
    requireSafe(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'INVALID_PRIVATE_FILE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function exclusiveWrite(file, data) {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function lock(root, fn) {
  const file = path.join(root, '.lock');
  try { exclusiveWrite(file, 'locked\n'); } catch (e) { if (e.code === 'EEXIST') throw new SafetyError('VAULT_BUSY'); throw e; }
  try { return fn(); } finally { unlinkSync(file); }
}
function key(password, salt) {
  requireSafe(typeof password === 'string' && password.length >= 16 && password.length <= 1024, 'PASSPHRASE_MINIMUM_16_CHARACTERS');
  return scryptSync(password, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
}
function b64(s, size) {
  requireSafe(typeof s === 'string' && Buffer.from(s, 'base64').toString('base64') === s && Buffer.from(s, 'base64').length === size, 'INVALID_VAULT_ENCODING');
  return Buffer.from(s, 'base64');
}
function validateHeader(header) {
  exactKeys(header, ['version', 'id', 'role', 'address', 'kdf']);
  requireSafe(header.version === 1 && ID.test(header.id) && ['buyer', 'payer', 'deployer', 'mint'].includes(header.role), 'INVALID_VAULT_HEADER');
  validAddress(header.address);
  requireSafe(canonical(header.kdf) === canonical(KDF), 'UNSUPPORTED_KDF');
}
export class Vault {
  constructor(root) { this.root = prepareRoot(root); }
  list() {
    return lock(this.root, () => {
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
        validateHeader(stored.header);
        requireSafe(canonical(stored.header) === canonical(h), 'MANIFEST_MISMATCH');
      }
      const expected = new Set(manifest.wallets.map(h => h.id + '.vault'));
      for (const file of readdirSync(this.root)) if (file.endsWith('.vault')) requireSafe(expected.has(file), 'UNREGISTERED_WALLET');
      return structuredClone(manifest.wallets);
    });
  }
  async create(id, role, password) {
    requireSafe(ID.test(id) && ['buyer', 'payer', 'deployer', 'mint'].includes(role), 'INVALID_WALLET_ID_OR_ROLE');
    const seed = randomBytes(32);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      const header = { version: 1, id, role, address: signer.address, kdf: KDF };
      const salt = randomBytes(32), iv = randomBytes(12), derived = key(password, salt);
      let encrypted, tag;
      try { const c = createCipheriv('aes-256-gcm', derived, iv); c.setAAD(Buffer.from(canonical(header))); encrypted = Buffer.concat([c.update(seed), c.final()]); tag = c.getAuthTag(); }
      finally { derived.fill(0); }
      // No overwrite, including stale/unregistered wallets.
      lock(this.root, () => {
        let manifest;
        try { manifest = JSON.parse(readPrivate(path.join(this.root, 'manifest.json'))); }
        catch (e) { if (e.code !== 'ENOENT') throw e; manifest = { version: 1, wallets: [] }; }
        exactKeys(manifest, ['version', 'wallets']);
        requireSafe(manifest.version === 1 && Array.isArray(manifest.wallets) && manifest.wallets.length < 24, 'WALLET_LIMIT');
        requireSafe(!manifest.wallets.some(w => w.id === id || w.address === header.address), 'WALLET_EXISTS');
        const payload = { header, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: encrypted.toString('base64') };
        exclusiveWrite(path.join(this.root, id + '.vault'), canonical(payload));
        manifest.wallets.push(header);
        const tmp = path.join(this.root, 'manifest-' + randomBytes(12).toString('hex') + '.tmp');
        exclusiveWrite(tmp, canonical(manifest)); renameSync(tmp, path.join(this.root, 'manifest.json'));
      });
      return header;
    } finally { seed.fill(0); }
  }
  async unlock(id, password) {
    requireSafe(ID.test(id), 'INVALID_WALLET_ID');
    const h = this.list().find(w => w.id === id); requireSafe(h, 'WALLET_NOT_REGISTERED');
    const payload = JSON.parse(readPrivate(path.join(this.root, id + '.vault')));
    exactKeys(payload, ['header', 'salt', 'iv', 'tag', 'ciphertext']); validateHeader(payload.header);
    requireSafe(canonical(payload.header) === canonical(h), 'MANIFEST_MISMATCH');
    const derived = key(password, b64(payload.salt, 32)); let seed;
    try {
      const c = createDecipheriv('aes-256-gcm', derived, b64(payload.iv, 12)); c.setAAD(Buffer.from(canonical(h))); c.setAuthTag(b64(payload.tag, 16));
      seed = Buffer.concat([c.update(b64(payload.ciphertext, 32)), c.final()]);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      requireSafe(signer.address === h.address, 'KEY_ADDRESS_MISMATCH');
      return signer;
    } catch { throw new SafetyError('VAULT_AUTHENTICATION_FAILED'); }
    finally { derived.fill(0); seed?.fill(0); }
  }
}
