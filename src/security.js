import { createHash, timingSafeEqual } from 'node:crypto';
import { address } from '@solana/kit';

export class SafetyError extends Error {
  constructor(code) { super(code); this.name = 'SafetyError'; this.code = code; }
}
export function requireSafe(test, code) { if (!test) throw new SafetyError(code); }
export const U64_MAX = (1n << 64n) - 1n;
export function raw(value, { positive = true } = {}) {
  requireSafe(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'INVALID_RAW_AMOUNT');
  const n = BigInt(value);
  requireSafe(n <= U64_MAX && (!positive || n > 0n), 'AMOUNT_OUT_OF_RANGE');
  return n;
}
export function percentage(value) {
  requireSafe(typeof value === 'string' && /^(?:[0-9]{1,2}|100)(?:\.[0-9]{1,2})?$/.test(value), 'INVALID_PERCENTAGE');
  const [a, b = ''] = value.split('.');
  const n = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
  requireSafe(n > 0n && n <= 10000n, 'INVALID_PERCENTAGE');
  return n;
}
export function validAddress(value) {
  try { return address(value); } catch { throw new SafetyError('INVALID_ADDRESS'); }
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireSafe(Number.isSafeInteger(value), 'INVALID_JSON_NUMBER'); return String(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireSafe(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_JSON_OBJECT');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function equalDigest(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function exactKeys(value, keys) {
  requireSafe(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'INVALID_FIELDS');
}
export function frozenJson(value) {
  const copy = JSON.parse(canonical(value));
  const freeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  return freeze(copy);
}
export function shortError(error) { return error instanceof SafetyError ? error.code : 'OPERATION_FAILED'; }
