import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, getProgramDerivedAddress, getAddressEncoder, getBase64EncodedWireTransaction } from '@solana/kit';
import { fundingPlan, sellPlan } from '../src/plans.js';
import { compileFunding, compileCurveSells, prepareFundingReview, prepareCurveSellReview, signReviewedBatch, PUMP, transactionFingerprint } from '../src/transactions.js';
import { Rpc, DEVNET_GENESIS } from '../src/network.js';
const clock = Date.now();
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n };
async function signer(n) { const seed = new Uint8Array(32); seed[0] = n; return createKeyPairSignerFromPrivateKeyBytes(seed); }
async function context() {
  return new Rpc({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const result = request.method === 'getGenesisHash' ? DEVNET_GENESIS : { value: { blockhash: lifetime.blockhash, lastValidBlockHeight: 100 } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } }).getBlockhashContext();
}
test('funding transactions are built locally and require exactly the payer signature', async () => {
  const payer = await signer(1), recipient = await signer(2), stranger = await signer(3);
  const envelope = fundingPlan({ payerAddress: payer.address, wallets: [{ id: 'buyer', address: recipient.address, lamports: '1000000' }], now: clock });
  const tx = compileFunding(envelope, envelope.digest, lifetime, clock);
  assert.deepEqual(Object.keys(tx.signatures), [payer.address]);
  const review = prepareFundingReview(envelope, envelope.digest, await context());
  await assert.rejects(signReviewedBatch(review, review.digest, []), /SIGNER_SET_MISMATCH/);
  await assert.rejects(signReviewedBatch(review, review.digest, [stranger]), /SIGNER_SET_MISMATCH/);
  await assert.rejects(signReviewedBatch(review, review.digest, [payer, stranger]), /SIGNER_SET_MISMATCH/);
  const [signed] = await signReviewedBatch(review, review.digest, [payer]);
  assert.ok(await crypto.subtle.verify('Ed25519', payer.keyPair.publicKey, signed.signatures[payer.address], signed.messageBytes));
  assert.ok(Buffer.from(getBase64EncodedWireTransaction(signed), 'base64').length <= 1232);
  assert.equal(transactionFingerprint(tx), transactionFingerprint(signed));
});
test('offline curve candidates preserve owner roles and cannot sign unverified trades', async () => {
  const a = await signer(4), b = await signer(5), mint = (await signer(6)).address;
  const envelope = sellPlan({ mint, wallets: [{ id: 'a', address: a.address, balanceRaw: '10000', quotedOutputLamports: '10000' }, { id: 'b', address: b.address, balanceRaw: '20000', quotedOutputLamports: '20000' }], percent: '10', now: clock });
  const curve = (await getProgramDerivedAddress({ programAddress: PUMP, seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mint)] }))[0];
  const state = { owner: PUMP, mint, complete: false, creator: a.address, feeRecipient: (await signer(7)).address, totalSupplyRaw: '100000', curve };
  const txs = await compileCurveSells(envelope, envelope.digest, lifetime, state, clock);
  assert.equal(txs.length, 2);
  const review = await prepareCurveSellReview(envelope, envelope.digest, lifetime, state);
  await assert.rejects(signReviewedBatch(review, review.digest, [a, b]), /UNVERIFIED_TRADE_SIGNING_DISABLED/);
  for (const [i, owner] of [a, b].entries()) {
    assert.deepEqual(Object.keys(txs[i].signatures), [owner.address]);
    assert.equal(review.details.signingAllowed, false);
  }
  for (const changed of [{ ...state, complete: true }, { ...state, owner: a.address }, { ...state, mint: a.address }, { ...state, curve: a.address }]) await assert.rejects(compileCurveSells(envelope, envelope.digest, lifetime, changed, clock));
});
test('raw or reconstructed transactions cannot bypass exact-message approval', async () => {
  assert.equal(Object.hasOwn(await import('../src/transactions.js'), 'signComplete'), false);
  const a = await signer(8), b = await signer(9);
  const envelope = fundingPlan({ payerAddress: a.address, wallets: [{ id: 'buyer', address: b.address, lamports: '1' }], now: clock });
  const review = prepareFundingReview(envelope, envelope.digest, await context());
  await assert.rejects(signReviewedBatch(structuredClone(review), review.digest, [a]), /REVIEW_NOT_ISSUED/);
  await assert.rejects(signReviewedBatch(review, envelope.digest, [a]), /REVIEW_NOT_ISSUED/);
  assert.equal(Object.isFrozen(review.details.transactions[0]), true);
  assert.throws(() => { review.details.transactions[0].messageBase64 = 'changed'; });
  await signReviewedBatch(review, review.digest, [a]);
  await assert.rejects(signReviewedBatch(review, review.digest, [a]), /REVIEW_NOT_ISSUED/);
});
test('approval is single-use even with concurrent signing calls', async () => {
  const a = await signer(10), b = await signer(11);
  const envelope = fundingPlan({ payerAddress: a.address, wallets: [{ id: 'buyer', address: b.address, lamports: '1' }], now: clock });
  const review = prepareFundingReview(envelope, envelope.digest, await context());
  const results = await Promise.allSettled([signReviewedBatch(review, review.digest, [a]), signReviewedBatch(review, review.digest, [a])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
test('review expires before keys can sign', async t => {
  const a = await signer(12), b = await signer(13);
  const envelope = fundingPlan({ payerAddress: a.address, wallets: [{ id: 'buyer', address: b.address, lamports: '1' }], now: clock });
  const review = prepareFundingReview(envelope, envelope.digest, await context());
  t.mock.method(Date, 'now', () => review.details.expiresAt);
  await assert.rejects(signReviewedBatch(review, review.digest, [a]), /EXPIRED/);
});
test('curve state and lifetime cannot change after validation across PDA awaits', async () => {
  const a = await signer(14), mint = (await signer(15)).address;
  const envelope = sellPlan({ mint, wallets: [{ id: 'buyer', address: a.address, balanceRaw: '10000', quotedOutputLamports: '10000' }], percent: '10', now: clock });
  const curve = (await getProgramDerivedAddress({ programAddress: PUMP, seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mint)] }))[0];
  const state = { owner: PUMP, mint, complete: false, creator: a.address, feeRecipient: (await signer(16)).address, totalSupplyRaw: '100000', curve };
  const mutableLifetime = { ...lifetime };
  const pending = prepareCurveSellReview(envelope, envelope.digest, mutableLifetime, state);
  state.feeRecipient = mint; mutableLifetime.blockhash = mint;
  const review = await pending;
  assert.equal(review.details.blockhash, lifetime.blockhash);
  await assert.rejects(signReviewedBatch(review, review.digest, [a]), /UNVERIFIED_TRADE_SIGNING_DISABLED/);
});
test('self-labeled or reconstructed devnet blockhashes cannot authorize signing', async () => {
  const a = await signer(17), b = await signer(18);
  const envelope = fundingPlan({ payerAddress: a.address, wallets: [{ id: 'buyer', address: b.address, lamports: '1' }], now: clock });
  assert.throws(() => prepareFundingReview(envelope, envelope.digest, lifetime), /UNVERIFIED_OR_EXPIRED_BLOCKHASH_CONTEXT/);
  const verified = await context();
  assert.throws(() => prepareFundingReview(envelope, envelope.digest, structuredClone(verified)), /UNVERIFIED_OR_EXPIRED_BLOCKHASH_CONTEXT/);
});
