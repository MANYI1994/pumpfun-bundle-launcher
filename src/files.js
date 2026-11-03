import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { requireSafe, SafetyError } from './security.js';

// O_NONBLOCK prevents a substituted FIFO from hanging before fstat can reject it.
// Bounded reads still hold if a regular file grows after the initial size check.
export function readRegularFile(file, { maxBytes = 65536, privateFile = false } = {}) {
  requireSafe(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1048576, 'INVALID_READ_LIMIT');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(maxBytes + 1);
  try {
    const stat = fstatSync(fd);
    requireSafe(stat.isFile() && stat.size <= maxBytes, 'INVALID_OR_OVERSIZED_FILE');
    if (privateFile) requireSafe(stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.nlink === 1, 'UNSAFE_FILE_PERMISSIONS');
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (n === 0) break;
      count += n;
    }
    requireSafe(count <= maxBytes, 'FILE_GREW_BEYOND_LIMIT');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)); }
    catch { throw new SafetyError('INVALID_UTF8'); }
  } finally { buffer.fill(0); closeSync(fd); }
}
