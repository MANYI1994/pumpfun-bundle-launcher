import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { requireSafe } from './security.js';
export function trustedDirectory(stat) {
  const owned = stat.uid === 0 || stat.uid === process.getuid();
  const writable = (stat.mode & 0o022) !== 0;
  // Root-owned sticky directories such as /tmp are safe ancestors, not vault roots.
  const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && owned && (!writable || stickyRoot), 'UNSAFE_VAULT_ANCESTOR');
}
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
    try { const stat = lstatSync(part); requireSafe(!stat.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED'); trustedDirectory(stat); }
    catch (e) { if (e.code !== 'ENOENT') throw e; mkdirSync(part, { mode: 0o700 }); }
  }
  const stat = lstatSync(root); requireSafe(stat.isDirectory(), 'INVALID_VAULT_DIRECTORY'); privateStat(stat);
  return realpathSync(root);
}
export class PrivateDirectory {
  #root; #identity;
  constructor(root) {
    requireSafe(process.platform === 'linux' && typeof process.getuid === 'function', 'LINUX_REQUIRED_FOR_PRIVATE_STATE');
    this.#root = prepareRoot(root); this.#identity = lstatSync(this.#root, { bigint: true });
  }
  get root() { return this.#root; }
  assert() {
    let part = path.parse(this.#root).root;
    for (const component of this.#root.slice(part.length).split(path.sep).filter(Boolean)) {
      part = path.join(part, component); trustedDirectory(lstatSync(part));
    }
    const stat = lstatSync(this.#root, { bigint: true });
    requireSafe(stat.dev === this.#identity.dev && stat.ino === this.#identity.ino && stat.isDirectory(), 'STATE_DIRECTORY_REPLACED');
    requireSafe(stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n, 'UNSAFE_FILE_PERMISSIONS');
  }
}
