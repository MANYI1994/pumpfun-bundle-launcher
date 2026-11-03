import { Rpc } from './network.js';
import { LIMITS } from './plans.js';
import { requireSafe } from './security.js';

export async function simulateVerifiedBuy(review, verified, rpc = new Rpc()) {
  const plan = review.details.plan;
  requireSafe(plan.action === 'buy' && verified.productionVerified && verified.transactions.length === 1, 'INVALID_BUY_SIMULATION');
  const { wireBase64, fingerprint } = verified.transactions[0];
  const result = await rpc.read('simulateTransaction', [wireBase64, {
    encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false,
  }]);
  const value = result?.value;
  requireSafe(value?.err === null && value.replacementBlockhash == null, 'BUY_SIMULATION_FAILED');
  const before = value.preBalances?.[0];
  const after = value.postBalances?.[0];
  requireSafe([before, after, value.fee].every(n => Number.isSafeInteger(n) && n >= 0), 'SIMULATION_BALANCE_EVIDENCE_UNAVAILABLE');
  requireSafe(value.fee === Number(review.details.budget.feeLamports), 'SIMULATED_FEE_CHANGED');
  // Include the reported fee conservatively even when the node's balance delta already includes it.
  const debit = BigInt(before) - BigInt(after) + BigInt(value.fee);
  requireSafe(before >= after && debit >= BigInt(plan.tradeBudgetLamports) &&
    debit <= BigInt(plan.maxDebitLamports), 'SIMULATED_DEBIT_OUTSIDE_APPROVAL');
  requireSafe(BigInt(before) - debit >= LIMITS.feeReserveLamports, 'SIMULATED_RESERVE_TOO_LOW');
  requireSafe(Date.now() < review.details.expiresAt, 'BUY_REVIEW_EXPIRED');
  return { verified: true, simulated: true, fingerprint, conservativeDebitLamports: String(debit),
    networkFeeLamports: String(value.fee), broadcast: false };
}
