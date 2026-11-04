import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { Rpc } from './network.js';
import { LIMITS } from './plans.js';
import { digest, exactKeys, frozenJson, raw, requireSafe, validAddress } from './security.js';
import { PUMP } from './transactions.js';

export const FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const FEES_DISCRIMINATOR = Buffer.from([143, 52, 146, 187, 219, 123, 76, 155]);
const BPS = 10000n;
const ceilDiv = (amount, divisor) => (amount + divisor - 1n) / divisor;
const encoder = getAddressEncoder();

function readCurve(data) {
  requireSafe(data.length >= 115 && data.subarray(0, 8).equals(CURVE_DISCRIMINATOR), 'UNSUPPORTED_CURVE_LAYOUT');
  requireSafe(data[48] === 0, 'CURVE_COMPLETE_OR_INVALID');
  requireSafe(data[81] === 0 && data[82] === 0 && !data[124] &&
    data.subarray(83, 115).every(byte => byte === 0), 'UNSUPPORTED_CURVE_MODE');
  const virtualTokens = data.readBigUInt64LE(8);
  const virtualSol = data.readBigUInt64LE(16);
  const realTokens = data.readBigUInt64LE(24);
  const realSol = data.readBigUInt64LE(32);
  const supply = data.readBigUInt64LE(40);
  requireSafe(virtualTokens > realTokens && realTokens > 0n && virtualSol > 0n && supply >= realTokens, 'INVALID_CURVE_RESERVES');
  return { virtualTokens, virtualSol, realTokens, realSol, supply, hasCreator: data.subarray(49, 81).some(byte => byte !== 0) };
}

export function selectFeeTier(data, marketCap) {
  // Borsh layout: discriminator, bump, admin, flat fees, tier count, tiers.
  requireSafe(data.length >= 69 && data.subarray(0, 8).equals(FEES_DISCRIMINATOR), 'INVALID_FEE_CONFIG');
  const count = data.readUInt32LE(65);
  requireSafe(count > 0 && count <= 256 && data.length >= 69 + 40 * count, 'INVALID_FEE_TIERS');
  let previous = -1n;
  let selected;
  for (let index = 0; index < count; index++) {
    const offset = 69 + index * 40;
    const threshold = data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
    requireSafe(threshold > previous, 'INVALID_FEE_TIER_ORDER');
    previous = threshold;
    if (index === 0 || threshold <= marketCap) {
      selected = { lpBps: data.readBigUInt64LE(offset + 16), protocolBps: data.readBigUInt64LE(offset + 24), creatorBps: data.readBigUInt64LE(offset + 32) };
    }
  }
  requireSafe(selected.lpBps + selected.protocolBps + selected.creatorBps < BPS, 'INVALID_FEE_RATE');
  return selected;
}

export async function reviewBuy(input, rpc = new Rpc()) {
  exactKeys(input, ['owner', 'mint', 'spendLamports', 'slippageBps']);
  const owner = validAddress(input.owner);
  const mint = validAddress(input.mint);
  const spend = raw(input.spendLamports);
  const { slippageBps } = input;
  requireSafe(spend <= LIMITS.maxSpendLamports, 'SPEND_LIMIT_EXCEEDED');
  requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 &&
    slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
  const observedAt = Date.now();
  const [{ curveAddress, curve, protocolBps, creatorBps }, balance] = await Promise.all([
    readSolCurve(mint, rpc), rpc.read('getBalance', [owner]),
  ]);
  requireSafe(Number.isSafeInteger(balance?.value) && balance.value >= 0, 'INVALID_SOL_BALANCE');
  requireSafe(BigInt(balance.value) >= spend + LIMITS.feeReserveLamports, 'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
  const { output, minimum, fees } = quoteCurveBuy(curve, spend, protocolBps, creatorBps, slippageBps);
  const review = {
    action: 'buy', cluster: 'devnet', route: 'sol-bonding-curve',
    owner, mint, curveAddress, observedAt, expiresAt: observedAt + 15000,
    tradeBudgetLamports: String(spend), walletBalanceLamports: String(balance.value),
    estimatedTradeFeesLamports: String(fees),
    protocolFeeBps: String(protocolBps), creatorFeeBps: String(creatorBps),
    expectedTokenAmountRaw: String(output), minimumTokenAmountRaw: String(minimum),
    slippageBps, networkAndRentIncluded: false, broadcast: false,
  };
  requireSafe(Date.now() < review.expiresAt, 'BUY_REVIEW_EXPIRED');
  return frozenJson({ review, digest: digest(review) });
}

export async function readSolCurve(mint, rpc) {
  validAddress(mint);
  const [[curveAddress], [feeAddress]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PUMP, seeds: [Buffer.from('bonding-curve'), encoder.encode(mint)] }),
    getProgramDerivedAddress({ programAddress: FEES_PROGRAM, seeds: [Buffer.from('fee_config'), encoder.encode(PUMP)] }),
  ]);
  const [curveData, feeData] = await Promise.all([
    rpc.account(curveAddress, PUMP), rpc.account(feeAddress, FEES_PROGRAM),
  ]);
  const curve = readCurve(curveData);
  const marketCap = curve.virtualSol * curve.supply / curve.virtualTokens;
  const { protocolBps, creatorBps } = selectFeeTier(feeData, marketCap);
  return { curveAddress, curve, protocolBps, creatorBps: curve.hasCreator ? creatorBps : 0n };
}

export function quoteCurveBuy(curve, spend, protocolBps, creatorBps, slippageBps) {
  const feesFor = net => ceilDiv(net * protocolBps, BPS) + ceilDiv(net * creatorBps, BPS);
  let net = spend * BPS / (BPS + protocolBps + creatorBps);
  const excess = net + feesFor(net) - spend;
  if (excess > 0n) net -= excess;
  requireSafe(net > 1n, 'BUY_ROUNDS_TO_ZERO');
  const output = (net - 1n) * curve.virtualTokens / (curve.virtualSol + net - 1n);
  requireSafe(output < curve.realTokens, 'BUY_WOULD_COMPLETE_CURVE');
  const minimum = output * (BPS - BigInt(slippageBps)) / BPS;
  requireSafe(minimum > 0n, 'BUY_ROUNDS_TO_ZERO');
  return { net, output, minimum, fees: feesFor(net) };
}
