import { getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';
import { Rpc } from './network.js';
import { exactKeys, frozenJson, requireSafe, validAddress } from './security.js';
import { PUMP } from './transactions.js';

export const PUMP_SWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
const CURVE_TAG = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const POOL_TAG = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const encoder = getAddressEncoder();
const bytes = address => Buffer.from(encoder.encode(address));

async function accountBytes(rpc, address, program) {
  const result = await rpc.read('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (result?.value === null) return null;
  const account = result?.value;
  requireSafe(account?.owner === program && account.executable === false &&
    Array.isArray(account.data) && account.data.length === 2 &&
    account.data[1] === 'base64' && typeof account.data[0] === 'string', 'MIGRATION_ACCOUNT_INVALID');
  const data = Buffer.from(account.data[0], 'base64');
  requireSafe(data.toString('base64') === account.data[0], 'MIGRATION_ACCOUNT_INVALID');
  return data;
}

export async function detectMigration(input, rpc = new Rpc()) {
  exactKeys(input, ['mint']);
  const mint = validAddress(input.mint);
  const mintBytes = bytes(mint);
  const [curve] = await getProgramDerivedAddress({
    programAddress: PUMP, seeds: [Buffer.from('bonding-curve'), mintBytes],
  });
  const data = await accountBytes(rpc, curve, PUMP);
  const details = { cluster: 'devnet', mint, curve, observedAt: Date.now() };
  if (!data) return frozenJson({ ...details, state: 'curve-not-found' });
  requireSafe(data.length >= 115 && data.subarray(0, 8).equals(CURVE_TAG) &&
    [0, 1].includes(data[48]), 'UNSUPPORTED_CURVE_LAYOUT');
  if (data.subarray(83, 115).some(byte => byte !== 0)) {
    return frozenJson({ ...details, state: 'unsupported-quote-mint' });
  }
  if (data[48] === 0) return frozenJson({ ...details, state: 'active-sol-curve' });

  const [authority] = await getProgramDerivedAddress({
    programAddress: PUMP, seeds: [Buffer.from('pool-authority'), mintBytes],
  });
  const [pool, bump] = await getProgramDerivedAddress({
    programAddress: PUMP_SWAP,
    seeds: [Buffer.from('pool'), Buffer.alloc(2), bytes(authority), mintBytes, bytes(WSOL)],
  });
  const poolData = await accountBytes(rpc, pool, PUMP_SWAP);
  if (!poolData) return frozenJson({ ...details, state: 'awaiting-canonical-pool', expectedPool: pool });
  requireSafe(poolData.length >= 211 && poolData.subarray(0, 8).equals(POOL_TAG) &&
    poolData[8] === bump && poolData.readUInt16LE(9) === 0 &&
    poolData.subarray(11, 43).equals(bytes(authority)) &&
    poolData.subarray(43, 75).equals(mintBytes) &&
    poolData.subarray(75, 107).equals(bytes(WSOL)), 'CANONICAL_POOL_IDENTITY_MISMATCH');
  const decode = getBase58Decoder();
  return frozenJson({ ...details, state: 'canonical-pool-found', pool,
    baseVault: decode.decode(poolData.subarray(139, 171)),
    quoteVault: decode.decode(poolData.subarray(171, 203)),
  });
}
