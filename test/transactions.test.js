import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, signTransaction, getProgramDerivedAddress, getAddressEncoder } from '@solana/kit';
import { fundingPlan, sellPlan, enforceFundingBudget } from '../src/plans.js';
import { compileFunding, compileCurveSells, prepareFundingReview, prepareOfflineFundingReview, prepareCurveSellReview, verifyReviewedBatch, PUMP } from '../src/transactions.js';
import { Rpc, DEVNET_GENESIS } from '../src/network.js';
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n };
async function signer(n) { const seed = new Uint8Array(32); seed[0] = n; return createKeyPairSignerFromPrivateKeyBytes(seed); }
async function fixture() {
  const owner = await signer(1), recipient = await signer(2);
  const envelope = fundingPlan({ payerAddress: owner.address, wallets: [{ id: 'buyer', address: recipient.address, lamports: '1000000' }] });
  const tx = compileFunding(envelope, envelope.digest, lifetime);
  const review = prepareOfflineFundingReview(envelope, envelope.digest, lifetime);
  // External-wallet simulation exists in tests only. Application code never signs.
  const signed = await signTransaction([owner.keyPair], tx);
  return { owner, envelope, review, tx, signed };
}
test('application exports no local signing API; external signatures match the reviewed bytes', async () => {
  const module = await import('../src/transactions.js');
  assert.equal('signComplete' in module, false); assert.equal('signReviewedBatch' in module, false);
  const { owner, review, signed } = await fixture();
  assert.ok(await crypto.subtle.verify('Ed25519', owner.keyPair.publicKey, signed.signatures[owner.address], signed.messageBytes));
  const result = await verifyReviewedBatch(review, review.digest, [signed]);
  assert.equal(result.productionVerified, false); assert.equal(result.broadcast, false);
  assert.ok(Object.isFrozen(result.transactions)); assert.ok(result.transactions[0].wireBase64.length > 0);
});
test('changed messages, missing signatures and forged signatures are rejected', async () => {
  const { owner, review, signed } = await fixture();
  const changed = new Uint8Array(signed.messageBytes); changed[changed.length - 1] ^= 1;
  await assert.rejects(verifyReviewedBatch(review, review.digest, [{ ...signed, messageBytes: changed }]), /MESSAGE_DIFFERS/);
  await assert.rejects(verifyReviewedBatch(review, review.digest, [{ ...signed, signatures: {} }]), /SIGNER_SET/);
  await assert.rejects(verifyReviewedBatch(review, review.digest, [{ ...signed, signatures: { [owner.address]: new Uint8Array(64) } }]), /INVALID_TRANSACTION_SIGNATURE/);
});
test('reviews cannot be reconstructed, replayed or used concurrently', async () => {
  const { review, signed } = await fixture();
  await assert.rejects(verifyReviewedBatch(structuredClone(review), review.digest, [signed]), /REVIEW_NOT_ISSUED/);
  const outcomes = await Promise.allSettled([verifyReviewedBatch(review, review.digest, [signed]), verifyReviewedBatch(review, review.digest, [signed])]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(verifyReviewedBatch(review, review.digest, [signed]), /REVIEW_NOT_ISSUED/);
});
test('external signature verification rejects expired reviews', async t => {
  const { review, signed } = await fixture(); t.mock.method(Date, 'now', () => review.details.expiresAt);
  await assert.rejects(verifyReviewedBatch(review, review.digest, [signed]), /REVIEW_EXPIRED/);
});
test('injected RPC cannot create production approval with fabricated genesis data', async () => {
  const { envelope } = await fixture();
  const rpc = new Rpc({ fetchImpl: async (_u, o) => { const p = JSON.parse(o.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: p.method === 'getGenesisHash' ? DEVNET_GENESIS : { value: { blockhash: lifetime.blockhash, lastValidBlockHeight: 100 } } })); } });
  const mockContext = await rpc.getBlockhashContext();
  await assert.rejects(prepareFundingReview(envelope, envelope.digest, mockContext), /UNVERIFIED_OR_EXPIRED/);
  await assert.rejects(prepareFundingReview(envelope, envelope.digest, lifetime), /UNVERIFIED_OR_EXPIRED/);
});
test('total debit includes fees and leaves the full reserve intact', async () => {
  const { envelope } = await fixture();
  const evidence = enforceFundingBudget(envelope.plan, { feeLamports: '5000', balanceLamports: '11005000' });
  assert.equal(evidence.remainingLamports, '10000000'); assert.equal(evidence.totalDebitLamports, '1005000');
  assert.throws(() => enforceFundingBudget(envelope.plan, { feeLamports: '5000', balanceLamports: '11004999' }), /INSUFFICIENT/);
  assert.throws(() => enforceFundingBudget({ totalSpendLamports: '1000000000' }, { feeLamports: '5000', balanceLamports: '2000000000' }), /TOTAL_DEBIT/);
  assert.throws(() => enforceFundingBudget(envelope.plan, { feeLamports: '0.1', balanceLamports: '2000000000' }));
});
test('unsigned sell candidates retain each owner and cannot authorize external trade verification', async () => {
  const a = await signer(4), b = await signer(5), mint = (await signer(6)).address;
  const envelope = sellPlan({ mint, wallets: [{ id: 'a', address: a.address, balanceRaw: '10000', quotedOutputLamports: '10000' }, { id: 'b', address: b.address, balanceRaw: '20000', quotedOutputLamports: '20000' }], percent: '10' });
  const curve = (await getProgramDerivedAddress({ programAddress: PUMP, seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mint)] }))[0];
  const state = { owner: PUMP, mint, complete: false, creator: a.address, feeRecipient: (await signer(7)).address, totalSupplyRaw: '100000', curve };
  const txs = await compileCurveSells(envelope, envelope.digest, lifetime, state);
  assert.deepEqual(txs.map(tx => Object.keys(tx.signatures)), [[a.address], [b.address]]);
  const mutableLifetime = { ...lifetime };
  const pending = prepareCurveSellReview(envelope, envelope.digest, mutableLifetime, state);
  state.feeRecipient = mint; mutableLifetime.blockhash = mint;
  const review = await pending;
  assert.equal(review.details.blockhash, lifetime.blockhash);
  await assert.rejects(verifyReviewedBatch(review, review.digest, txs), /UNVERIFIED_TRADE/);
  for (const changed of [{ ...state, complete: true }, { ...state, owner: a.address }, { ...state, mint: a.address }, { ...state, curve: a.address }]) await assert.rejects(compileCurveSells(envelope, envelope.digest, lifetime, changed));
});
test('external bytes cannot be swapped during asynchronous signature verification', async () => {
  const { review, signed } = await fixture();
  const pending = verifyReviewedBatch(review, review.digest, [signed]);
  signed.messageBytes[0] ^= 1;
  const result = await pending;
  assert.equal(result.transactions.length, 1); assert.equal(result.broadcast, false);
});
