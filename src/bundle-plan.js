import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { FEES_PROGRAM, quoteCurveBuy, selectFeeTier } from './buy-review.js';
import { Rpc } from './network.js';
import { PUMP } from './transactions.js';
import { httpsField, tokenMetadata } from './create-token.js';
import { LIMITS } from './plans.js';
import { digest, exactKeys, frozenJson, raw, requireSafe, validAddress } from './security.js';

const MAX_TRANSACTIONS = 5;

function validateLaunchPlan(input) {
  exactKeys(input, ['creatorAddress', 'mintAddress', 'metadata', 'metadataUri',
    'creationMaxDebitLamports', 'buyers']);
  const creatorAddress = validAddress(input.creatorAddress);
  const mintAddress = validAddress(input.mintAddress);
  requireSafe(creatorAddress !== mintAddress, 'MINT_AND_CREATOR_MUST_DIFFER');
  const metadata = tokenMetadata(input.metadata);
  const metadataUri = httpsField(input.metadataUri);
  const creationCap = raw(input.creationMaxDebitLamports);
  requireSafe(creationCap <= LIMITS.maxSpendLamports, 'CREATION_DEBIT_LIMIT_EXCEEDED');
  requireSafe(Array.isArray(input.buyers) && input.buyers.length >= 1 &&
    input.buyers.length < MAX_TRANSACTIONS, 'BUNDLE_BUYER_LIMIT');

  const seen = new Set([creatorAddress, mintAddress]);
  let total = creationCap;
  const buys = input.buyers.map(buyer => {
    exactKeys(buyer, ['address', 'spendLamports', 'maxDebitLamports', 'slippageBps']);
    const address = validAddress(buyer.address);
    requireSafe(!seen.has(address), 'DUPLICATE_BUNDLE_SIGNER');
    seen.add(address);
    const spend = raw(buyer.spendLamports);
    const cap = raw(buyer.maxDebitLamports);
    requireSafe(spend < cap && cap <= LIMITS.maxSpendLamports, 'INVALID_BUNDLE_BUY_BUDGET');
    const { slippageBps } = buyer;
    requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 &&
      slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
    total += cap;
    return { action: 'buy', payerAddress: address, requiredSigners: [address],
      spendLamports: String(spend), maxDebitLamports: String(cap), slippageBps,
      minimumOutputRaw: null };
  });

  const plan = {
    version: 1, action: 'launch-bundle', cluster: 'devnet', mode: 'rehearsal-plan',
    mintAddress, creatorAddress, metadata, metadataUri,
    transactionCount: 1 + buys.length, maxTransactions: MAX_TRANSACTIONS,
    totalDebitCapsLamports: String(total),
    steps: [{ action: 'create', payerAddress: creatorAddress,
      requiredSigners: [creatorAddress, mintAddress], maxDebitLamports: String(creationCap) }, ...buys],
    tipLamports: '0', broadcast: false,
  };
  return plan;
}

const GLOBAL_TAG = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);

export async function planLaunchBundle(input, rpc = new Rpc()) {
  const plan = validateLaunchPlan(input);
  const observedAt = Date.now();
  const [[globalAddress], [feeAddress]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PUMP, seeds: [Buffer.from('global')] }),
    getProgramDerivedAddress({ programAddress: FEES_PROGRAM,
      seeds: [Buffer.from('fee_config'), getAddressEncoder().encode(PUMP)] }),
  ]);
  const [global, feeData] = await Promise.all([
    rpc.account(globalAddress, PUMP), rpc.account(feeAddress, FEES_PROGRAM),
  ]);
  requireSafe(global.length >= 451 && global.subarray(0, 8).equals(GLOBAL_TAG) &&
    global[450] === 1, 'UNSUPPORTED_CREATION_CONFIG');
  const curve = {
    virtualTokens: global.readBigUInt64LE(73),
    virtualSol: global.readBigUInt64LE(81),
    realTokens: global.readBigUInt64LE(89),
    supply: global.readBigUInt64LE(97),
  };
  requireSafe(curve.virtualTokens > curve.realTokens && curve.realTokens > 0n &&
    curve.virtualSol > 0n && curve.supply >= curve.realTokens, 'INVALID_INITIAL_RESERVES');
  const reserves = () => ({
    virtualTokenReserveRaw: String(curve.virtualTokens),
    virtualSolReserveLamports: String(curve.virtualSol),
    realTokenReserveRaw: String(curve.realTokens),
  });
  const initialReserves = reserves();
  for (const step of plan.steps.slice(1)) {
    const marketCap = curve.virtualSol * curve.supply / curve.virtualTokens;
    const { protocolBps, creatorBps } = selectFeeTier(feeData, marketCap);
    const quote = quoteCurveBuy(curve, BigInt(step.spendLamports), protocolBps, creatorBps, step.slippageBps);
    step.expectedOutputRaw = String(quote.output);
    step.minimumOutputRaw = String(quote.minimum);
    step.estimatedTradeFeesLamports = String(quote.fees);
    curve.virtualTokens -= quote.output;
    curve.realTokens -= quote.output;
    curve.virtualSol += quote.net;
    step.projectedReservesAfter = reserves();
  }
  const quoted = { ...plan, initialReserves, observedAt, expiresAt: observedAt + 15000,
    quoteMode: 'sequential-estimate', networkAndRentIncluded: false };
  requireSafe(Date.now() < quoted.expiresAt, 'BUNDLE_REVIEW_EXPIRED');
  return frozenJson({ plan: quoted, digest: digest(quoted) });
}
