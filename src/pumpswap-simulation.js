import { raw, requireSafe } from './security.js';

function tokenAmount(rows, index, owner, mint) {
  requireSafe(Array.isArray(rows) && Number.isSafeInteger(index) && index >= 0,
    'SWAP_TOKEN_BALANCE_EVIDENCE_UNAVAILABLE');
  const matching = rows.filter(row => row?.accountIndex === index);
  requireSafe(matching.length === 1 && matching[0].owner === owner && matching[0].mint === mint,
    'SWAP_TOKEN_BALANCE_IDENTITY_MISMATCH');
  return raw(matching[0].uiTokenAmount?.amount, { positive: false });
}

export function checkSwapTokenChanges(plan, result) {
  const { preTokenBalances: before, postTokenBalances: after } = result.value;
  const sourceBefore = tokenAmount(before, plan.sourceAccountIndex, plan.owner, plan.sourceMint);
  const sourceAfter = tokenAmount(after, plan.sourceAccountIndex, plan.owner, plan.sourceMint);
  const destinationBefore = tokenAmount(before, plan.destinationAccountIndex, plan.owner, plan.destinationMint);
  const destinationAfter = tokenAmount(after, plan.destinationAccountIndex, plan.owner, plan.destinationMint);
  const debit = sourceBefore - sourceAfter;
  const credit = destinationAfter - destinationBefore;
  const approvedInput = raw(plan.inputAmountRaw);
  requireSafe(debit > 0n && debit <= approvedInput && (plan.side === 'buy' || debit === approvedInput),
    'SWAP_INPUT_OUTSIDE_APPROVAL');
  requireSafe(credit >= raw(plan.minimumOutputRaw), 'SWAP_OUTPUT_BELOW_MINIMUM');
  return { inputDebitedRaw: String(debit), outputCreditedRaw: String(credit),
    inputUnit: plan.inputUnit, outputUnit: plan.outputUnit };
}
