import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { detectMigration, PUMP_SWAP } from '../src/migration.js';
import { PUMP } from '../src/transactions.js';

const mint = 'SysvarRent111111111111111111111111111111111';
const wsol = 'So11111111111111111111111111111111111111112';
const bytes = address => Buffer.from(getAddressEncoder().encode(address));
const account = (owner, data) => ({ owner, executable: false, data: [data.toString('base64'), 'base64'] });

test('migration distinguishes active, awaiting and canonical pool states', async () => {
  const curve = Buffer.alloc(115);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve);
  const [authority] = await getProgramDerivedAddress({
    programAddress: PUMP, seeds: [Buffer.from('pool-authority'), bytes(mint)],
  });
  const [poolAddress, bump] = await getProgramDerivedAddress({
    programAddress: PUMP_SWAP,
    seeds: [Buffer.from('pool'), Buffer.alloc(2), bytes(authority), bytes(mint), bytes(wsol)],
  });
  let pool = null;
  const rpc = { async read(_method, [address]) {
    return { value: address === poolAddress ? pool && account(PUMP_SWAP, pool) : account(PUMP, curve) };
  } };
  assert.equal((await detectMigration({ mint }, rpc)).state, 'active-sol-curve');
  curve[48] = 1;
  assert.equal((await detectMigration({ mint }, rpc)).state, 'awaiting-canonical-pool');
  pool = Buffer.alloc(211);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(pool);
  pool[8] = bump;
  bytes(authority).copy(pool, 11);
  bytes(mint).copy(pool, 43);
  bytes(wsol).copy(pool, 75);
  const result = await detectMigration({ mint }, rpc);
  assert.equal(result.state, 'canonical-pool-found');
  assert.equal(result.pool, poolAddress);
  pool[43] ^= 1;
  await assert.rejects(detectMigration({ mint }, rpc), /CANONICAL_POOL_IDENTITY_MISMATCH/);
});
