import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, signTransaction, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { collectionPlan, validateEnvelope, enforceCollectionBudgets } from '../src/plans.js';
import { digest } from '../src/security.js';
import { compileCollection, prepareOfflineCollectionReview, prepareCollectionReview, verifyReviewedBatch } from '../src/transactions.js';
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n };
async function wallet(n) { const seed = new Uint8Array(32); seed[0] = n; return createKeyPairSignerFromPrivateKeyBytes(seed); }
async function fixture() {
  const a = await wallet(51), b = await wallet(52), destination = await wallet(53);
  const input = { destinationAddress: destination.address, wallets: [{ id: 'a', address: a.address, lamports: '1000000' }, { id: 'b', address: b.address, lamports: '2000000' }] };
  const envelope = collectionPlan(input);
  return { a, b, destination, input, envelope };
}
test('collection preserves explicit destination, quantities, separate payers and signatures', async () => {
  const { a, b, envelope } = await fixture();
  assert.equal(envelope.plan.totalSpendLamports, '3000000');
  const txs = compileCollection(envelope, envelope.digest, lifetime);
  assert.deepEqual(txs.map(tx => Object.keys(tx.signatures)), [[a.address], [b.address]]);
  const review = prepareOfflineCollectionReview(envelope, envelope.digest, lifetime);
  const signed = await Promise.all(txs.map((tx, i) => signTransaction([[a, b][i].keyPair], tx)));
  const result = await verifyReviewedBatch(review, review.digest, signed);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.broadcast, false); assert.equal(result.productionVerified, false);
  await assert.rejects(verifyReviewedBatch(review, review.digest, signed), /REVIEW_NOT_ISSUED/);
});
test('collection refuses self, duplicate, zero, excessive and unrecognized transfer fields', async () => {
  const { input } = await fixture();
  assert.throws(() => collectionPlan({ ...input, destinationAddress: input.wallets[0].address }), /SELF_TRANSFER/);
  assert.throws(() => collectionPlan({ ...input, wallets: [input.wallets[0], input.wallets[0]] }), /DUPLICATE_WALLET/);
  for (const lamports of ['0', '-1', '0.1', '1000000001']) assert.throws(() => collectionPlan({ ...input, wallets: [{ ...input.wallets[0], lamports }] }));
  assert.throws(() => collectionPlan({ ...input, wallets: [{ ...input.wallets[0], tipRecipient: input.destinationAddress }] }));
});
test('rehashed collection totals, destination changes and partial signatures cannot bypass review', async () => {
  const { a, b, input, envelope } = await fixture();
  const altered = structuredClone(envelope); altered.plan.totalSpendLamports = '1'; altered.digest = digest(altered.plan);
  assert.throws(() => validateEnvelope(altered, altered.digest), /SCHEMA_MISMATCH/);
  const review = prepareOfflineCollectionReview(envelope, envelope.digest, lifetime);
  const changed = collectionPlan({ ...input, destinationAddress: (await wallet(54)).address });
  const changedTxs = compileCollection(changed, changed.digest, lifetime);
  const signed = await Promise.all(changedTxs.map((tx, i) => signTransaction([[a, b][i].keyPair], tx)));
  await assert.rejects(verifyReviewedBatch(review, review.digest, signed), /MESSAGE_DIFFERS/);
  await assert.rejects(verifyReviewedBatch(review, review.digest, signed.slice(0, 1)), /TRANSACTION_COUNT/);
  await assert.rejects(prepareCollectionReview(envelope, envelope.digest, lifetime), /UNVERIFIED_OR_EXPIRED/);
});

test('decoded collection wire has exactly one System transfer to the approved destination', async () => {
  const { envelope } = await fixture();
  const txs = compileCollection(envelope, envelope.digest, lifetime);
  for (let i = 0; i < txs.length; i++) {
    const decoded = getCompiledTransactionMessageDecoder().decode(txs[i].messageBytes);
    assert.equal(decoded.instructions.length, 1);
    const ix = decoded.instructions[0];
    assert.equal(decoded.staticAccounts[ix.programAddressIndex], '11111111111111111111111111111111');
    assert.deepEqual(ix.accountIndices.map(n => decoded.staticAccounts[n]), [envelope.plan.wallets[i].address, envelope.plan.destinationAddress]);
    const data = Buffer.from(ix.data);
    assert.equal(data.length, 12); assert.equal(data.readUInt32LE(), 2);
    assert.equal(data.readBigUInt64LE(4), BigInt(envelope.plan.wallets[i].lamports));
  }
});
test('collection budgets include all fees and protect each individual source reserve', async () => {
  const { envelope, input } = await fixture();
  const evidence = input.wallets.map(w => ({ address: w.address, feeLamports: '5000', balanceLamports: String(BigInt(w.lamports) + 10005000n) }));
  const budgets = enforceCollectionBudgets(envelope.plan, evidence);
  assert.ok(budgets.every(b => b.remainingLamports === '10000000'));
  assert.ok(Object.isFrozen(budgets));
  assert.throws(() => enforceCollectionBudgets(envelope.plan, [...evidence].reverse()), /EVIDENCE_MISMATCH/);
  assert.throws(() => enforceCollectionBudgets(envelope.plan, [evidence[0]]), /EVIDENCE_MISMATCH/);
  assert.throws(() => enforceCollectionBudgets(envelope.plan, [evidence[0], { ...evidence[1], balanceLamports: '12004999' }]), /INSUFFICIENT/);
  const capped = collectionPlan({ ...input, wallets: input.wallets.map(w => ({ ...w, lamports: '500000000' })) });
  assert.throws(() => enforceCollectionBudgets(capped.plan, evidence.map(w => ({ ...w, balanceLamports: '1000000000' }))), /TOTAL_DEBIT_LIMIT/);
});
