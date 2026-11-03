import test from 'node:test';
import assert from 'node:assert/strict';
import { raw, percentage, digest, canonical, shortError } from '../src/security.js';
import { fundingPlan, sellPlan, validateEnvelope } from '../src/plans.js';
const a = '11111111111111111111111111111111';
const b = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const c = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const clock = 100000;
function sale(overrides = {}) { return sellPlan({ mint: c, wallets: [{ id: 'buyer-one', address: a, balanceRaw: '1000000000', quotedOutputLamports: '2000000' }], percent: '10', now: clock, ...overrides }); }
test('integer amounts reject signs, floats, exponent, whitespace, unsafe JSON numbers and overflow', () => {
  for (const v of ['-1', '1.5', '1e9', ' 1', '01', 'Infinity', '18446744073709551616', 123, null]) assert.throws(() => raw(v));
  assert.equal(raw('18446744073709551615'), (1n << 64n) - 1n);
});
test('percentage parsing uses exact basis points', () => {
  assert.equal(percentage('10.25'), 1025n);
  for (const v of ['0', '100.01', 'NaN', '1e2', '-2', '1.001', 10]) assert.throws(() => percentage(v));
});
test('canonical hashes ignore object key ordering and reject unsupported types', () => {
  assert.equal(digest({ a: '1', b: '2' }), digest({ b: '2', a: '1' }));
  assert.throws(() => canonical({ x: undefined }));
  assert.throws(() => canonical({ x: NaN }));
  assert.equal(shortError(new Error('secret value')), 'OPERATION_FAILED');
});
test('sell quantities apply separately to selected wallet balances and preserve proceeds', () => {
  const e = sale({ wallets: [{ id: 'buyer-a', address: a, balanceRaw: '1000', quotedOutputLamports: '100' }, { id: 'buyer-b', address: b, balanceRaw: '3000', quotedOutputLamports: '300' }] });
  assert.deepEqual(e.plan.wallets.map(w => w.amountRaw), ['100', '300']);
  assert.equal(e.plan.totalAmountRaw, '400'); assert.equal(e.plan.proceeds, 'original-wallets'); assert.equal(e.plan.broadcast, false);
  assert.ok(e.plan.wallets.every(w => BigInt(w.minimumOutputLamports) > 0n));
});
test('zero sale, zero return, excessive slippage, unverified routes and tips fail closed', () => {
  assert.throws(() => sale({ wallets: [{ id: 'a', address: a, balanceRaw: '1', quotedOutputLamports: '100' }] }));
  assert.throws(() => sale({ wallets: [{ id: 'a', address: a, balanceRaw: '100', quotedOutputLamports: '0' }] }));
  assert.throws(() => sale({ slippageBps: 301 }));
  assert.throws(() => sale({ slippageBps: NaN }));
  assert.throws(() => sale({ tipLamports: '1000001' }));
  assert.throws(() => sale({ route: 'raydium' }));
  assert.throws(() => sale({ route: 'pumpswap' }));
});
test('empty, duplicate wallet addresses/ids and overlarge selections rejected', () => {
  assert.throws(() => sale({ wallets: [] }));
  const w = sale().plan.wallets[0];
  const rows = [{ id: w.id, address: a, balanceRaw: '100', quotedOutputLamports: '100' }];
  assert.throws(() => sale({ wallets: [...rows, rows[0]] }));
  assert.throws(() => sale({ wallets: [...rows, { ...rows[0], address: b }] }));
  assert.throws(() => sale({ wallets: Array(6).fill(rows[0]) }));
});
test('funding caps total spend and rejects own destination', () => {
  assert.throws(() => fundingPlan({ payerAddress: a, wallets: [{ id: 'b', address: b, lamports: '1000000001' }] }));
  assert.throws(() => fundingPlan({ payerAddress: a, wallets: [{ id: 'b', address: b, lamports: '600000000' }, { id: 'c', address: c, lamports: '600000000' }] }));
  assert.throws(() => fundingPlan({ payerAddress: a, wallets: [{ id: 'a', address: a, lamports: '1' }] }));
});
test('immutable plans require exact approval and expire in sixty seconds', () => {
  const e = sale(); assert.ok(Object.isFrozen(e.plan.wallets[0]));
  assert.equal(validateEnvelope(e, e.digest, clock + 1).action, 'sell');
  assert.throws(() => validateEnvelope(e, 'wrong', clock));
  assert.throws(() => validateEnvelope(e, e.digest, clock - 1));
  assert.throws(() => validateEnvelope(e, e.digest, clock + 60000));
});
test('re-hashing a tampered plan cannot bypass schema or derived-amount policy', () => {
  for (const mutate of [p => p.wallets[0].minimumOutputLamports = '0', p => p.totalAmountRaw = '99999', p => p.extra = true, p => p.broadcast = true, p => p.wallets[0].amountRaw = '99999', p => p.cluster = 'mainnet']) {
    const p = structuredClone(sale().plan); mutate(p); const e = { plan: p, digest: digest(p) };
    assert.throws(() => validateEnvelope(e, e.digest, clock));
  }
});
