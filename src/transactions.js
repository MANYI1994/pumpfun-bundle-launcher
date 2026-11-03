import { randomUUID } from 'node:crypto';
import {
  AccountRole, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compileTransaction, assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction, getTransactionDecoder, getSignatureFromTransaction, getAddressEncoder, getProgramDerivedAddress,
} from '@solana/kit';
import { raw, requireSafe, validAddress, digest, frozenJson, equalDigest } from './security.js';
import { validateEnvelope, LIMITS, enforceFundingBudget, enforceCollectionBudgets } from './plans.js';
import { assertDevnetContext, fundingBudgetEvidence } from './network.js';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const bytes = a => getAddressEncoder().encode(validAddress(a));
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (address, writable = false, signer = false) => ({ address: validAddress(address), role: signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (writable ? AccountRole.WRITABLE : AccountRole.READONLY) });
async function pda(programAddress, seeds) { return (await getProgramDerivedAddress({ programAddress, seeds }))[0]; }
export async function tokenAccount(owner, mint) { return pda(ASSOCIATED, [bytes(owner), bytes(TOKEN), bytes(mint)]); }
export function transferInstruction(from, to, lamports) {
  requireSafe(from !== to, 'SELF_TRANSFER');
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2);
  return { programAddress: SYSTEM, accounts: [meta(from, true, true), meta(to, true)], data: Buffer.concat([tag, u64(raw(String(lamports)))]) };
}
export function message(payer, lifetime, instructions) {
  validAddress(payer); validAddress(lifetime.blockhash);
  requireSafe(typeof lifetime.lastValidBlockHeight === 'bigint' && lifetime.lastValidBlockHeight > 0n, 'INVALID_BLOCKHASH_LIFETIME');
  let m = createTransactionMessage({ version: 'legacy' });
  m = setTransactionMessageFeePayer(payer, m);
  m = setTransactionMessageLifetimeUsingBlockhash(lifetime, m);
  return appendTransactionMessageInstructions(instructions, m);
}
export function bounded(tx) {
  const wire = getBase64EncodedWireTransaction(tx);
  requireSafe(Buffer.from(wire, 'base64').length <= 1232, 'TRANSACTION_TOO_LARGE');
  return tx;
}
export function compileFunding(envelope, confirmation, lifetime, now = Date.now()) {
  const plan = validateEnvelope(envelope, confirmation, now);
  requireSafe(plan.action === 'fund' && plan.tipLamports === '0', 'UNSUPPORTED_FUNDING_PLAN');
  const instructions = plan.wallets.map(w => transferInstruction(plan.payerAddress, w.address, w.lamports));
  return bounded(compileTransaction(message(plan.payerAddress, lifetime, instructions)));
}

// Each source wallet pays its own fee and signs only its own transfer.
export function compileCollection(envelope, confirmation, lifetime, now = Date.now()) {
  const plan = validateEnvelope(envelope, confirmation, now);
  requireSafe(plan.action === 'collect', 'UNSUPPORTED_COLLECTION_PLAN');
  return plan.wallets.map(w => bounded(compileTransaction(message(w.address, lifetime,
    [transferInstruction(w.address, plan.destinationAddress, w.lamports)]))));
}
export function prepareOfflineCollectionReview(envelope, confirmation, lifetime) {
  const snapshot = Object.freeze({ blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
  return issueReview(envelope, compileCollection(envelope, confirmation, snapshot), snapshot);
}
export async function prepareCollectionReview(envelope, confirmation, context) {
  const approved = frozenJson(envelope);
  const snapshot = Object.freeze(assertDevnetContext(context));
  const transactions = compileCollection(approved, confirmation, snapshot);
  const evidenceRows = [];
  for (let i = 0; i < transactions.length; i++) {
    const w = approved.plan.wallets[i];
    const evidence = await fundingBudgetEvidence(context, w.address,
      Buffer.from(transactions[i].messageBytes).toString('base64'));
    evidenceRows.push({ address: w.address, ...evidence });
  }
  const budgets = enforceCollectionBudgets(approved.plan, evidenceRows);
  assertDevnetContext(context);
  return issueReview(approved, transactions, snapshot, context, budgets);
}

// Offline candidate builder only. No broadcast path accepts these messages yet.
// All required token-owner signatures are retained; no consolidation or random payer.
export async function compileCurveSells(envelope, confirmation, lifetime, state, now = Date.now()) {
  const plan = validateEnvelope(envelope, confirmation, now);
  state = frozenJson(state);
  lifetime = Object.freeze({ blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
  requireSafe(plan.action === 'sell' && plan.tipLamports === '0', 'UNSUPPORTED_SELL_PLAN');
  requireSafe(state && state.owner === PUMP && state.mint === plan.mint && state.complete === false, 'CURVE_OR_MINT_MISMATCH');
  validAddress(state.creator); validAddress(state.feeRecipient);
  requireSafe(raw(state.totalSupplyRaw) >= raw(plan.totalAmountRaw), 'SALE_EXCEEDS_SUPPLY');
  const curve = await pda(PUMP, [Buffer.from('bonding-curve'), bytes(plan.mint)]);
  requireSafe(state.curve === curve, 'CURVE_ADDRESS_MISMATCH');
  const global = await pda(PUMP, [Buffer.from('global')]);
  const creatorVault = await pda(PUMP, [Buffer.from('creator-vault'), bytes(state.creator)]);
  const event = await pda(PUMP, [Buffer.from('__event_authority')]);
  const curveAta = await tokenAccount(curve, plan.mint);
  const feeProgram = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
  const feeConfig = await pda(feeProgram, [Buffer.from('fee_config'), bytes(PUMP)]);
  const transactions = [];
  for (const w of plan.wallets) {
    const ata = await tokenAccount(w.address, plan.mint);
    const instruction = { programAddress: PUMP, accounts: [meta(global), meta(state.feeRecipient, true), meta(plan.mint), meta(curve, true), meta(curveAta, true), meta(ata, true), meta(w.address, true, true), meta(SYSTEM), meta(creatorVault, true), meta(TOKEN), meta(event), meta(PUMP), meta(feeConfig), meta(feeProgram)], data: Buffer.concat([SELL_DISCRIMINATOR, u64(raw(w.amountRaw)), u64(raw(w.minimumOutputLamports))]) };
    transactions.push(bounded(compileTransaction(message(w.address, lifetime, [instruction]))));
  }
  requireSafe(transactions.length <= LIMITS.maxWallets, 'BUNDLE_TOO_LARGE');
  return transactions;
}
export function transactionFingerprint(transaction) { return digest({ message: Buffer.from(transaction.messageBytes).toString('base64'), signers: Object.keys(transaction.signatures) }); }

// Only reviews issued by this module can be signed. Serialized hashes alone are
// not capabilities: raw caller-supplied transaction objects are never accepted.
const pendingReviews = new WeakMap();
const verifiedExecutions = new WeakMap();
const executionPermits = new WeakMap();
function issueReview(envelope, transactions, lifetime, context = null, budget = null) {
  const plan = validateEnvelope(envelope, envelope.digest);
  return issueValidatedReview(plan, envelope.digest, transactions, lifetime, context, budget);
}
function issueValidatedReview(plan, planDigest, transactions, lifetime, context, budget) {
  const details = {
    version: 1, cluster: 'devnet', plan, planDigest,
    expiresAt: context ? Math.min(plan.expiresAt, context.expiresAt) : plan.expiresAt,
    signingAllowed: false, verificationAllowed: ['fund', 'collect'].includes(plan.action) || Boolean(context && ['buy', 'sell', 'cleanup', 'create'].includes(plan.action)), productionVerified: Boolean(context), budget,
    blockhash: lifetime.blockhash, lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    transactions: transactions.map(tx => ({ messageBase64: Buffer.from(tx.messageBytes).toString('base64'), requiredSigners: Object.keys(tx.signatures).sort(), fingerprint: transactionFingerprint(tx) })),
    broadcast: false,
  };
  const review = frozenJson({ details, digest: digest(details) });
  pendingReviews.set(review, { transactions, context });
  return review;
}
export async function prepareFundingReview(envelope, confirmation, context) {
  const approved = frozenJson(envelope);
  const snapshot = Object.freeze(assertDevnetContext(context));
  const tx = compileFunding(approved, confirmation, snapshot);
  const evidence = await fundingBudgetEvidence(context, approved.plan.payerAddress, Buffer.from(tx.messageBytes).toString('base64'));
  const budget = enforceFundingBudget(approved.plan, evidence);
  assertDevnetContext(context);
  return issueReview(approved, [tx], snapshot, context, budget);
}
export async function prepareBuySigningReview(input, maxDebitLamports) {
  const maxDebit = raw(maxDebitLamports);
  requireSafe(maxDebit <= LIMITS.maxSpendLamports, 'TOTAL_DEBIT_LIMIT_EXCEEDED');
  const { compileBuyCandidate } = await import('./buy-transaction.js');
  const { candidate, tx, context } = await compileBuyCandidate(input);
  const lifetime = assertDevnetContext(context);
  const evidence = await fundingBudgetEvidence(context, candidate.owner, Buffer.from(tx.messageBytes).toString('base64'));
  requireSafe(BigInt(candidate.tradeBudgetLamports) + BigInt(evidence.feeLamports) <= maxDebit, 'TRADE_AND_FEE_EXCEED_CAP');
  requireSafe(BigInt(evidence.balanceLamports) >= maxDebit + LIMITS.feeReserveLamports, 'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
  requireSafe(Date.now() < candidate.expiresAt, 'BUY_REVIEW_EXPIRED');
  const plan = frozenJson({ ...candidate, id: randomUUID(), payerAddress: candidate.owner, maxDebitLamports });
  return issueValidatedReview(plan, digest(plan), [tx], lifetime, context, evidence);
}
export async function prepareSellSigningReview(input) {
  const { compileSellCandidate } = await import('./sell-transaction.js');
  const { candidate, tx, context } = await compileSellCandidate(input);
  const lifetime = assertDevnetContext(context);
  const evidence = await fundingBudgetEvidence(context, candidate.owner, Buffer.from(tx.messageBytes).toString('base64'));
  requireSafe(BigInt(evidence.balanceLamports) >= BigInt(evidence.feeLamports) + LIMITS.feeReserveLamports,
    'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
  requireSafe(Date.now() < candidate.expiresAt, 'SELL_REVIEW_EXPIRED');
  const plan = frozenJson({ ...candidate, id: randomUUID(), payerAddress: candidate.owner });
  return issueValidatedReview(plan, digest(plan), [tx], lifetime, context, evidence);
}

export async function prepareCleanupSigningReview(input) {
  const { compileCleanup } = await import('./cleanup.js');
  const { candidate, tx, context } = await compileCleanup(input);
  const lifetime = assertDevnetContext(context);
  const evidence = await fundingBudgetEvidence(context, candidate.owner, Buffer.from(tx.messageBytes).toString('base64'));
  const fee = BigInt(evidence.feeLamports);
  requireSafe(BigInt(evidence.balanceLamports) >= fee + LIMITS.feeReserveLamports,
    'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
  const minimum = BigInt(candidate.recoveredLamports) - 2n * fee;
  requireSafe(minimum > 0n, 'CLEANUP_RECOVERY_TOO_LOW');
  const plan = frozenJson({ ...candidate, id: randomUUID(), minimumOutputLamports: String(minimum) });
  return issueValidatedReview(plan, digest(plan), [tx], lifetime, context, evidence);
}

export async function prepareCreationExecution(envelope, context, maxDebitLamports, signedWires) {
  const lifetime = assertDevnetContext(context);
  const cap = raw(maxDebitLamports);
  requireSafe(cap <= LIMITS.maxSpendLamports, 'TOTAL_DEBIT_LIMIT_EXCEEDED');
  const { verifyCreationSignatures } = await import('./create-verification.js');
  const signed = await verifyCreationSignatures(envelope, envelope.digest, signedWires);
  const creation = envelope.review;
  requireSafe(creation.blockhash === lifetime.blockhash &&
    creation.lastValidBlockHeight === String(lifetime.lastValidBlockHeight), 'CREATION_CONTEXT_MISMATCH');
  const tx = getTransactionDecoder().decode(Buffer.from(creation.unsignedWireBase64, 'base64'));
  const evidence = await fundingBudgetEvidence(context, creation.creatorAddress, Buffer.from(tx.messageBytes).toString('base64'));
  requireSafe(BigInt(evidence.feeLamports) <= cap && BigInt(evidence.balanceLamports) >= cap + LIMITS.feeReserveLamports,
    'INSUFFICIENT_BALANCE_OR_FEE_RESERVE');
  const plan = frozenJson({ action: 'create', id: randomUUID(), payerAddress: creation.creatorAddress,
    mintAddress: creation.mintAddress, bondingCurve: creation.bondingCurve, metadataUri: creation.metadataUri,
    maxDebitLamports: String(cap), tradeBudgetLamports: '0', expiresAt: context.expiresAt });
  const review = issueValidatedReview(plan, digest(plan), [tx], lifetime, context, evidence);
  const result = await verifySignedWireBatch(review, review.digest, [signed.signedWireBase64]);
  return { review, result };
}

export function prepareOfflineFundingReview(envelope, confirmation, lifetime) {
  const snapshot = Object.freeze({ blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
  return issueReview(envelope, [compileFunding(envelope, confirmation, snapshot)], snapshot);
}
export async function prepareCurveSellReview(envelope, confirmation, lifetime, state) {
  const snapshot = Object.freeze({ blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
  // Snapshot the envelope before any await to bind the review to the built plan.
  const approved = frozenJson(envelope);
  const txs = await compileCurveSells(approved, confirmation, snapshot, state);
  return issueReview(approved, txs, snapshot);
}
export async function verifyReviewedBatch(review, confirmation, signedTransactions) {
  const issued = pendingReviews.get(review);
  requireSafe(issued && equalDigest(confirmation, review.digest) && equalDigest(review.digest, digest(review.details)), 'REVIEW_NOT_ISSUED_OR_UNAPPROVED');
  requireSafe(review.details.verificationAllowed && ['fund', 'collect', 'buy', 'sell', 'cleanup', 'create'].includes(review.details.plan.action), 'UNVERIFIED_TRADE_SIGNING_DISABLED');
  const { transactions, context } = issued;
  if (context) assertDevnetContext(context);
  requireSafe(Date.now() < review.details.expiresAt, 'REVIEW_EXPIRED');
  requireSafe(Array.isArray(signedTransactions) && signedTransactions.length === transactions.length, 'TRANSACTION_COUNT_MISMATCH');
  // Copy all untrusted bytes before any asynchronous verification.
  const snapshots = signedTransactions.map((input, i) => {
    const expected = transactions[i];
    requireSafe(input?.messageBytes instanceof Uint8Array && Buffer.from(input.messageBytes).equals(Buffer.from(expected.messageBytes)), 'MESSAGE_DIFFERS_FROM_REVIEW');
    const required = Object.keys(expected.signatures).sort();
    requireSafe(input.signatures && Object.keys(input.signatures).sort().join(',') === required.join(','), 'SIGNER_SET_MISMATCH');
    const signatures = {};
    for (const owner of required) {
      requireSafe(input.signatures[owner] instanceof Uint8Array && input.signatures[owner].length === 64, 'MISSING_OR_INVALID_SIGNATURE');
      signatures[owner] = new Uint8Array(input.signatures[owner]);
    }
    return { ...expected, messageBytes: new Uint8Array(expected.messageBytes), signatures };
  });
  pendingReviews.delete(review);
  const output = [];
  for (const tx of snapshots) {
    if (context) assertDevnetContext(context);
    requireSafe(Date.now() < review.details.expiresAt, 'REVIEW_EXPIRED');
    for (const [owner, signature] of Object.entries(tx.signatures)) {
      const publicKey = await crypto.subtle.importKey('raw', bytes(owner), 'Ed25519', false, ['verify']);
      requireSafe(await crypto.subtle.verify('Ed25519', publicKey, signature, tx.messageBytes), 'INVALID_TRANSACTION_SIGNATURE');
    }
    assertIsFullySignedTransaction(tx);
    bounded(tx);
    output.push({ wireBase64: getBase64EncodedWireTransaction(tx), fingerprint: transactionFingerprint(tx), signature: getSignatureFromTransaction(tx) });
  }
  if (context) assertDevnetContext(context);
  requireSafe(Date.now() < review.details.expiresAt, 'REVIEW_EXPIRED');
  const execution = frozenJson({ version: 1, cluster: 'devnet', planDigest: review.details.planDigest,
    expiresAt: review.details.expiresAt, lastValidBlockHeight: review.details.lastValidBlockHeight, transactions: output });
  const result = frozenJson({ transactions: output, productionVerified: Boolean(context), broadcast: false, executionDigest: digest(execution) });
  const { plan, budget } = review.details;
  if (plan.action === 'collect' && plan.wallets.length === 1 && context) {
    verifiedExecutions.set(result, {
      context, execution,
      plan: frozenJson({ ...plan, payerAddress: plan.wallets[0].address }),
      budget: budget[0],
    });
  } else {
    verifiedExecutions.set(result, { context, execution, plan, budget });
  }
  return result;
}

// Export only server-issued production reviews, never arbitrary caller messages.
export function externalSigningPayload(review, confirmation, expectedAddress) {
  const issued = pendingReviews.get(review);
  requireSafe(issued && equalDigest(confirmation, review.digest), 'REVIEW_NOT_ISSUED_OR_UNAPPROVED');
  requireSafe(review.details.productionVerified && review.details.verificationAllowed, 'UNVERIFIED_WALLET_REQUEST');
  assertDevnetContext(issued.context);
  validAddress(expectedAddress);
  requireSafe(Date.now() < review.details.expiresAt, 'REVIEW_EXPIRED');
  requireSafe(review.details.transactions.every(tx => tx.requiredSigners.length === 1 && tx.requiredSigners[0] === expectedAddress), 'CONNECTED_WALLET_MISMATCH');
  return frozenJson({ review, expectedAddress, chain: 'solana:devnet',
    unsignedTransactions: issued.transactions.map(tx => getBase64EncodedWireTransaction(tx)) });
}
export async function verifySignedWireBatch(review, confirmation, wires) {
  requireSafe(Array.isArray(wires) && wires.length > 0 && wires.length <= LIMITS.maxWallets, 'INVALID_WIRE_BATCH');
  const transactions = wires.map(wire => {
    requireSafe(typeof wire === 'string' && wire.length <= 1644, 'INVALID_TRANSACTION_WIRE');
    const data = Buffer.from(wire, 'base64');
    requireSafe(data.length <= 1232 && data.toString('base64') === wire, 'INVALID_TRANSACTION_WIRE');
    let tx;
    try { tx = getTransactionDecoder().decode(data); }
    catch { requireSafe(false, 'INVALID_TRANSACTION_WIRE'); }
    requireSafe(getBase64EncodedWireTransaction(tx) === wire, 'NONCANONICAL_TRANSACTION_WIRE');
    return tx;
  });
  return verifyReviewedBatch(review, confirmation, transactions);
}

// One-use handoff from verification to the isolated native-transfer executor.
export function claimVerifiedExecution(batch, confirmation) {
  const record = verifiedExecutions.get(batch);
  requireSafe(record && batch.productionVerified && equalDigest(confirmation, batch.executionDigest), 'EXECUTION_NOT_VERIFIED_OR_APPROVED');
  assertDevnetContext(record.context);
  requireSafe(['fund', 'buy', 'sell', 'collect', 'cleanup', 'create'].includes(record.plan.action) && record.execution.transactions.length === 1, 'EXECUTION_ROUTE_NOT_ENABLED');
  verifiedExecutions.delete(batch);
  const permit = Object.freeze({ executionDigest: batch.executionDigest });
  executionPermits.set(permit, { ...record, used: false });
  return permit;
}
export function inspectExecutionPermit(permit) {
  const record = executionPermits.get(permit);
  requireSafe(record && !record.used, 'EXECUTION_PERMIT_INVALID_OR_CONSUMED');
  assertDevnetContext(record.context);
  requireSafe(Date.now() < record.execution.expiresAt, 'EXECUTION_APPROVAL_EXPIRED');
  return frozenJson({ executionDigest: permit.executionDigest, ...record.execution,
    plan: record.plan, budget: record.budget, blockhash: record.context.blockhash });
}
export function consumeExecutionPermit(permit) {
  const descriptor = inspectExecutionPermit(permit);
  executionPermits.get(permit).used = true;
  return descriptor;
}
