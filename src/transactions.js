import {
  AccountRole, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compileTransaction, assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction, getAddressEncoder, getProgramDerivedAddress,
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
function message(payer, lifetime, instructions) {
  validAddress(payer); validAddress(lifetime.blockhash);
  requireSafe(typeof lifetime.lastValidBlockHeight === 'bigint' && lifetime.lastValidBlockHeight > 0n, 'INVALID_BLOCKHASH_LIFETIME');
  let m = createTransactionMessage({ version: 'legacy' });
  m = setTransactionMessageFeePayer(payer, m);
  m = setTransactionMessageLifetimeUsingBlockhash(lifetime, m);
  return appendTransactionMessageInstructions(instructions, m);
}
function bounded(tx) {
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
function issueReview(envelope, transactions, lifetime, context = null, budget = null) {
  const plan = validateEnvelope(envelope, envelope.digest);
  const details = {
    version: 1, cluster: 'devnet', plan, planDigest: envelope.digest,
    expiresAt: context ? Math.min(plan.expiresAt, context.expiresAt) : plan.expiresAt,
    signingAllowed: false, verificationAllowed: ['fund', 'collect'].includes(plan.action), productionVerified: Boolean(context), budget,
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
  requireSafe(review.details.verificationAllowed && ['fund', 'collect'].includes(review.details.plan.action), 'UNVERIFIED_TRADE_SIGNING_DISABLED');
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
    output.push({ wireBase64: getBase64EncodedWireTransaction(tx), fingerprint: transactionFingerprint(tx) });
  }
  if (context) assertDevnetContext(context);
  requireSafe(Date.now() < review.details.expiresAt, 'REVIEW_EXPIRED');
  return frozenJson({ transactions: output, productionVerified: Boolean(context), broadcast: false });
}
