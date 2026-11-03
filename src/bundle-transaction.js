import { getTransactionDecoder } from '@solana/kit';
import { planLaunchBundle } from './bundle-plan.js';
import { compileLaunchBuyCandidate } from './buy-transaction.js';
import { reviewTokenCreation } from './create-token.js';
import { Rpc, assertDevnetContext, fundingBudgetEvidence } from './network.js';
import { LIMITS } from './plans.js';
import { digest, frozenJson, requireSafe } from './security.js';

export async function buildLaunchBundle(input, rpc = new Rpc()) {
  const { plan } = await planLaunchBundle(input, rpc);
  const context = await rpc.getBlockhashContext();
  const lifetime = assertDevnetContext(context);
  const mint = await rpc.read('getAccountInfo', [plan.mintAddress, { encoding: 'base64', commitment: 'confirmed' }]);
  requireSafe(mint?.value === null, 'BUNDLE_MINT_ALREADY_EXISTS');
  const { review: creation } = await reviewTokenCreation({
    metadata: plan.metadata, metadataUri: plan.metadataUri,
    creatorAddress: plan.creatorAddress, mintAddress: plan.mintAddress,
  }, lifetime);
  const buys = await Promise.all(plan.steps.slice(1).map(async step => {
    const { candidate } = await compileLaunchBuyCandidate({
      action: 'buy', owner: step.payerAddress, mint: plan.mintAddress,
      curveAddress: creation.bondingCurve, expiresAt: plan.expiresAt,
      tradeBudgetLamports: step.spendLamports, minimumTokenAmountRaw: step.minimumOutputRaw,
    }, rpc, context);
    return candidate;
  }));
  const candidates = [creation, ...buys];
  const transactions = await Promise.all(candidates.map(async (candidate, index) => {
    const step = plan.steps[index];
    const tx = getTransactionDecoder().decode(Buffer.from(candidate.unsignedWireBase64, 'base64'));
    requireSafe(candidate.requiredSigners.length === step.requiredSigners.length &&
      step.requiredSigners.every(address => candidate.requiredSigners.includes(address)),
    'BUNDLE_SIGNER_MISMATCH');
    const evidence = await fundingBudgetEvidence(context, step.payerAddress,
      Buffer.from(tx.messageBytes).toString('base64'));
    const cap = BigInt(step.maxDebitLamports);
    requireSafe(BigInt(evidence.balanceLamports) >= cap + LIMITS.feeReserveLamports,
      'BUNDLE_INSUFFICIENT_PAYER_RESERVE');
    requireSafe(BigInt(step.spendLamports ?? '0') + BigInt(evidence.feeLamports) <= cap,
      'BUNDLE_TRADE_AND_FEE_EXCEED_CAP');
    return { ...step, ...evidence, requiredSigners: candidate.requiredSigners, fingerprint: candidate.fingerprint,
      unsignedWireBase64: candidate.unsignedWireBase64,
      ...(index ? { destinationTokenAccount: candidate.destinationTokenAccount,
        buybackFeeRecipient: candidate.buybackFeeRecipient } : { bondingCurve: creation.bondingCurve }) };
  }));
  assertDevnetContext(context);
  const expiresAt = Math.min(plan.expiresAt, context.expiresAt);
  requireSafe(Date.now() < expiresAt, 'BUNDLE_REVIEW_EXPIRED');
  const review = { ...plan, mode: 'unsigned-bundle-rehearsal', expiresAt,
    blockhash: lifetime.blockhash, lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    transactions, rentVerified: false, signingAllowed: false, broadcast: false };
  return frozenJson({ review, digest: digest(review) });
}
