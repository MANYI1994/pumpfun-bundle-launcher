import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, getProgramDerivedAddress, getAddressEncoder, getBase64EncodedWireTransaction } from '@solana/kit';
import { fundingPlan, sellPlan } from '../src/plans.js';
import { compileFunding, compileCurveSells, signComplete, PUMP, transactionFingerprint } from '../src/transactions.js';
const clock = 100000;
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n };
async function signer(n) { const seed = new Uint8Array(32); seed[0] = n; return createKeyPairSignerFromPrivateKeyBytes(seed); }
test('funding transactions are built locally and require exactly the payer signature', async () => {
  const payer = await signer(1), recipient = await signer(2), stranger = await signer(3);
  const envelope = fundingPlan({ payerAddress: payer.address, wallets: [{ id: 'buyer', address: recipient.address, lamports: '1000000' }], now: clock });
  const tx = compileFunding(envelope, envelope.digest, lifetime, clock);
  assert.deepEqual(Object.keys(tx.signatures), [payer.address]);
  await assert.rejects(signComplete(tx, []), /SIGNER_SET_MISMATCH/);
  await assert.rejects(signComplete(tx, [stranger]), /SIGNER_SET_MISMATCH/);
  await assert.rejects(signComplete(tx, [payer, stranger]), /SIGNER_SET_MISMATCH/);
  const signed = await signComplete(tx, [payer]);
  assert.ok(await crypto.subtle.verify('Ed25519', payer.keyPair.publicKey, signed.signatures[payer.address], signed.messageBytes));
  assert.ok(Buffer.from(getBase64EncodedWireTransaction(signed), 'base64').length <= 1232);
  assert.equal(transactionFingerprint(tx), transactionFingerprint(signed));
});
test('independent curve sales require every actual owner and retain nonzero minimum proceeds', async () => {
  const a = await signer(4), b = await signer(5), mint = (await signer(6)).address;
  const envelope = sellPlan({ mint, wallets: [{ id: 'a', address: a.address, balanceRaw: '10000', quotedOutputLamports: '10000' }, { id: 'b', address: b.address, balanceRaw: '20000', quotedOutputLamports: '20000' }], percent: '10', now: clock });
  const curve = (await getProgramDerivedAddress({ programAddress: PUMP, seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mint)] }))[0];
  const state = { owner: PUMP, mint, complete: false, creator: a.address, feeRecipient: (await signer(7)).address, totalSupplyRaw: '100000', curve };
  const txs = await compileCurveSells(envelope, envelope.digest, lifetime, state, clock);
  assert.equal(txs.length, 2);
  for (const [i, owner] of [a, b].entries()) {
    assert.deepEqual(Object.keys(txs[i].signatures), [owner.address]);
    const signed = await signComplete(txs[i], [owner]);
    assert.ok(await crypto.subtle.verify('Ed25519', owner.keyPair.publicKey, signed.signatures[owner.address], signed.messageBytes));
  }
  for (const changed of [{ ...state, complete: true }, { ...state, owner: a.address }, { ...state, mint: a.address }, { ...state, curve: a.address }]) await assert.rejects(compileCurveSells(envelope, envelope.digest, lifetime, changed, clock));
});
test('signer must be complete across all owners, including developer/consolidation-like messages', async () => {
  const a = await signer(8), b = await signer(9);
  const { createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction } = await import('@solana/kit');
  const { transferInstruction } = await import('../src/transactions.js');
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(a.address, message);
  message = setTransactionMessageLifetimeUsingBlockhash(lifetime, message);
  message = appendTransactionMessageInstructions([transferInstruction(a.address, b.address, '1'), transferInstruction(b.address, a.address, '1')], message);
  const tx = compileTransaction(message);
  await assert.rejects(signComplete(tx, [a]), /SIGNER_SET_MISMATCH/);
  const signed = await signComplete(tx, [a, b]);
  for (const s of [a, b]) assert.ok(await crypto.subtle.verify('Ed25519', s.keyPair.publicKey, signed.signatures[s.address], signed.messageBytes));
});
