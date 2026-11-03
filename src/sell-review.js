import { readSolCurve } from './buy-review.js';
import { Rpc } from './network.js';
import { LIMITS } from './plans.js';
import { digest, exactKeys, frozenJson, percentage, requireSafe, validAddress } from './security.js';
import { balances } from './wallet-balances.js';

const BPS = 10000n;
const fee = (amount, rate) => (amount * rate + BPS - 1n) / BPS;

export async function reviewSell(input, rpc = new Rpc()) {
  exactKeys(input, ['owner', 'mint', 'percent', 'slippageBps']);
  const owner = validAddress(input.owner);
  const mint = validAddress(input.mint);
  const percentBps = percentage(input.percent);
  const { slippageBps } = input;
  requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 &&
    slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
  const observedAt = Date.now();
  const [{ curveAddress, curve, protocolBps, creatorBps }, balance] = await Promise.all([
    readSolCurve(mint, rpc), balances(rpc, owner, mint),
  ]);
  const accounts = balance.associatedTokenAccounts.filter(account => !account.frozen && account.rawAmount !== '0');
  requireSafe(accounts.length === 1, 'ONE_FUNDED_UNFROZEN_TOKEN_ACCOUNT_REQUIRED');
  const account = accounts[0];
  const amount = BigInt(account.rawAmount) * percentBps / BPS;
  requireSafe(amount > 0n && amount <= curve.supply, 'INVALID_SELL_AMOUNT');
  const gross = amount * curve.virtualSol / (curve.virtualTokens + amount);
  requireSafe(gross <= curve.realSol, 'INSUFFICIENT_CURVE_SOL');
  const fees = fee(gross, protocolBps) + fee(gross, creatorBps);
  const net = gross - fees;
  const minimum = net * (BPS - BigInt(slippageBps)) / BPS;
  requireSafe(minimum > 0n, 'SALE_ROUNDS_TO_ZERO');
  const review = {
    action: 'sell', cluster: 'devnet', route: 'sol-bonding-curve',
    owner, mint, curveAddress, sourceTokenAccount: account.address, baseTokenProgram: account.program,
    tokenBalanceRaw: account.rawAmount, amountRaw: String(amount), percentBps: String(percentBps),
    grossOutputLamports: String(gross), estimatedTradeFeesLamports: String(fees),
    expectedOutputLamports: String(net), minimumOutputLamports: String(minimum),
    protocolFeeBps: String(protocolBps), creatorFeeBps: String(creatorBps), slippageBps,
    observedAt, expiresAt: observedAt + 15000, networkAndRentIncluded: false, broadcast: false,
  };
  requireSafe(Date.now() < review.expiresAt, 'SELL_REVIEW_EXPIRED');
  return frozenJson({ review, digest: digest(review) });
}
