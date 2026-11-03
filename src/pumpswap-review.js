import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { selectFeeTier } from './buy-review.js';
import { detectMigration, PUMP_SWAP } from './migration.js';
import { Rpc } from './network.js';
import { LIMITS } from './plans.js';
import { digest, exactKeys, frozenJson, percentage, raw, requireSafe, validAddress } from './security.js';
import { ASSOCIATED, TOKEN } from './transactions.js';
import { balances } from './wallet-balances.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const BPS = 10000n;
const POOL_TAG = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const bytes = address => Buffer.from(getAddressEncoder().encode(address));
const fee = (amount, rate) => (amount * rate + BPS - 1n) / BPS;

function readMint(account) {
  requireSafe(account?.executable === false && [TOKEN, TOKEN_2022].includes(account.owner) &&
    Array.isArray(account.data) && account.data[1] === 'base64' && typeof account.data[0] === 'string', 'INVALID_POOL_MINT');
  const data = Buffer.from(account.data[0], 'base64');
  requireSafe(data.toString('base64') === account.data[0] && data.length >= 82 && data[45] === 1, 'INVALID_POOL_MINT');
  if (data.length !== 82) {
    requireSafe(account.owner === TOKEN_2022 && data.length >= 166 && data[165] === 1, 'UNSUPPORTED_POOL_MINT_EXTENSIONS');
    let offset = 166;
    while (offset < data.length) {
      requireSafe(offset + 4 <= data.length, 'UNSUPPORTED_POOL_MINT_EXTENSIONS');
      const type = data.readUInt16LE(offset);
      const size = data.readUInt16LE(offset + 2);
      requireSafe([18, 19].includes(type) && offset + 4 + size <= data.length, 'UNSUPPORTED_POOL_MINT_EXTENSIONS');
      offset += 4 + size;
    }
  }
  const supply = data.readBigUInt64LE(36);
  requireSafe(supply > 0n, 'INVALID_POOL_MINT_SUPPLY');
  return { supply, program: account.owner };
}

async function readVault(rpc, address, pool, mint, program) {
  const [expected] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED, seeds: [bytes(pool), bytes(program), bytes(mint)],
  });
  requireSafe(address === expected, 'POOL_VAULT_ADDRESS_MISMATCH');
  const data = await rpc.account(address, program);
  requireSafe(data.length >= 165 && data[108] === 1 &&
    data.subarray(0, 32).equals(bytes(mint)) && data.subarray(32, 64).equals(bytes(pool)),
  'INVALID_POOL_VAULT');
  return data.readBigUInt64LE(64);
}

export async function reviewPumpSwap(input, rpc = new Rpc()) {
  const { side } = input;
  requireSafe(side === 'buy' || side === 'sell', 'INVALID_SWAP_SIDE');
  exactKeys(input, ['side', 'owner', 'mint', 'slippageBps', side === 'buy' ? 'spendLamports' : 'percent']);
  const owner = validAddress(input.owner);
  const mint = validAddress(input.mint);
  const { slippageBps } = input;
  requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 &&
    slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
  const amountInput = side === 'buy' ? raw(input.spendLamports) : percentage(input.percent);
  if (side === 'buy') requireSafe(amountInput <= LIMITS.maxSpendLamports, 'SPEND_LIMIT_EXCEEDED');
  const observedAt = Date.now();
  const route = await detectMigration({ mint }, rpc);
  requireSafe(route.state === 'canonical-pool-found', 'CANONICAL_POOL_REQUIRED');
  const [feeAddress] = await getProgramDerivedAddress({
    programAddress: FEES, seeds: [Buffer.from('fee_config'), bytes(PUMP_SWAP)],
  });
  const [mintAccount, pool, feeData, balance] = await Promise.all([
    rpc.read('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc.account(route.pool, PUMP_SWAP), rpc.account(feeAddress, FEES),
    balances(rpc, owner, side === 'sell' ? mint : ''),
  ]);
  const { supply, program } = readMint(mintAccount?.value);
  requireSafe(pool.length >= 261 && pool.subarray(0, 8).equals(POOL_TAG) &&
    pool.subarray(43, 75).equals(bytes(mint)) && pool.subarray(75, 107).equals(bytes(WSOL)) &&
    pool[243] === 0 && pool[244] === 0 &&
    !pool[270] && (pool.length < 269 || pool.readBigUInt64LE(261) === 0n), 'UNSUPPORTED_POOL_LAYOUT_OR_MODE');
  requireSafe(pool.subarray(139, 171).equals(bytes(route.baseVault)) &&
    pool.subarray(171, 203).equals(bytes(route.quoteVault)), 'POOL_VAULT_CHANGED');
  const [base, actualQuote] = await Promise.all([
    readVault(rpc, route.baseVault, route.pool, mint, program),
    readVault(rpc, route.quoteVault, route.pool, WSOL, TOKEN),
  ]);
  const virtualQuote = (pool.readBigInt64LE(253) << 64n) + pool.readBigUInt64LE(245);
  const quote = actualQuote + virtualQuote;
  requireSafe(base > 0n && quote > 0n && quote <= (1n << 64n) - 1n, 'INVALID_POOL_RESERVES');
  const rates = selectFeeTier(feeData, quote * supply / base);
  const creatorRate = pool.subarray(211, 243).some(byte => byte !== 0) ? rates.creatorBps : 0n;
  const feesFor = amount => fee(amount, rates.lpBps) + fee(amount, rates.protocolBps) + fee(amount, creatorRate);

  let amount, output, fees;
  if (side === 'buy') {
    amount = amountInput;
    requireSafe(BigInt(balance.lamports) >= amount + LIMITS.feeReserveLamports, 'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
    let net = amount * BPS / (BPS + rates.lpBps + rates.protocolBps + creatorRate);
    const excess = net + feesFor(net) - amount;
    if (excess > 0n) net -= excess;
    requireSafe(net > 1n, 'SWAP_ROUNDS_TO_ZERO');
    fees = feesFor(net);
    output = (net - 1n) * base / (quote + net - 1n);
  } else {
    const source = balance.associatedTokenAccounts.find(account => account.program === program && !account.frozen);
    requireSafe(source, 'SWAP_SOURCE_ACCOUNT_UNAVAILABLE');
    amount = BigInt(source.rawAmount) * amountInput / BPS;
    requireSafe(amount > 0n && amount <= supply, 'INVALID_SWAP_AMOUNT');
    const gross = amount * quote / (base + amount);
    requireSafe(gross <= actualQuote, 'INSUFFICIENT_POOL_QUOTE_LIQUIDITY');
    fees = feesFor(gross);
    output = gross - fees;
  }
  const minimum = output * (BPS - BigInt(slippageBps)) / BPS;
  requireSafe(minimum > 0n, 'SWAP_ROUNDS_TO_ZERO');
  const review = {
    cluster: 'devnet', route: 'pumpswap', side, owner, mint, pool: route.pool,
    baseVault: route.baseVault, quoteVault: route.quoteVault,
    baseReserveRaw: String(base), effectiveQuoteReserveLamports: String(quote),
    inputUnit: side === 'buy' ? 'lamports' : 'token-raw',
    outputUnit: side === 'buy' ? 'token-raw' : 'lamports',
    inputAmountRaw: String(amount), expectedOutputRaw: String(output), minimumOutputRaw: String(minimum),
    estimatedTradeFeesLamports: String(fees), lpFeeBps: String(rates.lpBps),
    protocolFeeBps: String(rates.protocolBps), creatorFeeBps: String(creatorRate),
    slippageBps, observedAt, expiresAt: observedAt + 15000, broadcast: false,
  };
  requireSafe(Date.now() < review.expiresAt, 'SWAP_REVIEW_EXPIRED');
  return frozenJson({ review, digest: digest(review) });
}
