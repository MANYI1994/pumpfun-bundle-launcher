import { LIMITS } from './plans.js';
import { requireSafe } from './security.js';

export function sellSimulationBudget(plan, expectedFeeLamports, result) {
  const value = result?.value;
  requireSafe(value?.err === null && value.replacementBlockhash == null, 'SELL_SIMULATION_FAILED');
  const before = value.preBalances?.[0];
  const after = value.postBalances?.[0];
  requireSafe([before, after, value.fee].every(n => Number.isSafeInteger(n) && n >= 0),
    'SIMULATION_BALANCE_EVIDENCE_UNAVAILABLE');
  requireSafe(value.fee === Number(expectedFeeLamports), 'SIMULATED_FEE_CHANGED');
  const fee = BigInt(value.fee);
  requireSafe(BigInt(before) >= fee + LIMITS.feeReserveLamports, 'SIMULATED_RESERVE_TOO_LOW');
  // Subtract the fee conservatively even if the node already included it in the delta.
  const conservativeNet = BigInt(after) - BigInt(before) - fee;
  requireSafe(conservativeNet >= BigInt(plan.minimumOutputLamports), 'SIMULATED_SELL_PROCEEDS_TOO_LOW');
  return {
    feeLamports: String(fee),
    conservativeNetProceedsLamports: String(conservativeNet),
    remainingLamports: String(BigInt(after) - fee),
  };
}
