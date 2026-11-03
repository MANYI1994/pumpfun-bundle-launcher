import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getTransactionDecoder, getBase64EncodedWireTransaction, signTransaction } from '@solana/kit';
import { WalletSession, discoverWallets, fromBase64, toBase64 } from '../web/wallet.js';
import { fundingPlan } from '../src/plans.js';
import { compileFunding, prepareOfflineFundingReview, externalSigningPayload, verifySignedWireBatch } from '../src/transactions.js';
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n };
async function signer(n) { const bytes = new Uint8Array(32); bytes[0] = n; return createKeyPairSignerFromPrivateKeyBytes(bytes); }
async function fixture() {
  const owner = await signer(71), recipient = await signer(72);
  const envelope = fundingPlan({ payerAddress: owner.address, wallets: [{ id: 'test', address: recipient.address, lamports: '1000000' }] });
  const review = prepareOfflineFundingReview(envelope, envelope.digest, lifetime);
  const tx = compileFunding(envelope, envelope.digest, lifetime);
  // Simulated public production metadata only for the browser adapter unit tests.
  // The server's issued-review capability cannot be created from this clone.
  const payload = { review: structuredClone(review), expectedAddress: owner.address, chain: 'solana:devnet', unsignedTransactions: [getBase64EncodedWireTransaction(tx)] };
  payload.review.details.productionVerified = true;
  const account = { address: owner.address, publicKey: getAddressEncoder().encode(owner.address), chains: ['solana:devnet'], features: ['solana:signTransaction'] };
  let change, calls = 0, sends = 0;
  const wallet = { name: 'Test wallet', version: '1.0.0', chains: ['solana:devnet'], accounts: [account], features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'standard:events': { version: '1.0.0', on: (_event, fn) => { change = fn; return () => { change = null; }; } },
    'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async (...requests) => {
      calls++; return Promise.all(requests.map(async request => {
        assert.equal(request.account, account); assert.equal(request.chain, 'solana:devnet');
        const signed = await signTransaction([owner.keyPair], getTransactionDecoder().decode(request.transaction));
        return { signedTransaction: fromBase64(getBase64EncodedWireTransaction(signed)) };
      }));
    } },
    'solana:signAndSendTransaction': { signAndSendTransaction() { sends++; throw new Error('Must never broadcast'); } },
  } };
  const session = new WalletSession();
  await session.connect(wallet);
  return { owner, recipient, review, payload, account, wallet, session, change: () => change?.({ accounts: [] }), counts: () => ({ calls, sends }) };
}
test('external wallet signs reviewed wire and server verifies it without broadcasting', async () => {
  const { session, payload, review, counts } = await fixture();
  const wires = await session.sign(payload, payload.review.digest);
  const result = await verifySignedWireBatch(review, review.digest, wires);
  assert.equal(result.broadcast, false); assert.equal(result.transactions.length, 1);
  assert.deepEqual(counts(), { calls: 1, sends: 0 });
  await assert.rejects(verifySignedWireBatch(review, review.digest, wires), /REVIEW_NOT_ISSUED/);
});
test('browser rejects wrong account, mainnet, unverified, expired and unapproved requests before wallet prompts', async () => {
  const { session, payload, counts, recipient } = await fixture();
  for (const mutate of [
    p => { p.expectedAddress = recipient.address; },
    p => { p.chain = 'solana:mainnet'; },
    p => { p.review.details.productionVerified = false; },
    p => { p.review.details.expiresAt = Date.now() - 1; },
    p => { p.review.details.transactions[0].requiredSigners = [recipient.address]; },
    p => { p.review.details.plan.action = 'create'; },
    p => { p.review.details.broadcast = true; },
  ]) {
    const changed = structuredClone(payload); mutate(changed);
    await assert.rejects(session.sign(changed, changed.review.digest));
  }
  await assert.rejects(session.sign(payload, '0'.repeat(64)), /NOT_APPROVED/);
  assert.deepEqual(counts(), { calls: 0, sends: 0 });
});
test('changed wire and account public-key mismatch are refused before signature request', async () => {
  const { session, payload, account, counts } = await fixture();
  const changed = structuredClone(payload); const bytes = fromBase64(changed.unsignedTransactions[0]); bytes[bytes.length - 1] ^= 1;
  changed.unsignedTransactions[0] = toBase64(bytes);
  await assert.rejects(session.sign(changed, changed.review.digest), /MESSAGE_DIFFERS/);
  account.publicKey = new Uint8Array(32);
  await assert.rejects(session.sign(payload, payload.review.digest), /CONNECTED_WALLET_MISMATCH/);
  assert.equal(counts().calls, 0);
});
test('wallet errors are sanitized and account changes invalidate an in-flight signature', async () => {
  const f = await fixture();
  f.wallet.features['solana:signTransaction'].signTransaction = async () => { throw new Error('secret provider diagnostic'); };
  await assert.rejects(f.session.sign(f.payload, f.payload.review.digest), /^Error: WALLET_SIGNATURE_REJECTED$/);
  let release;
  f.wallet.features['solana:signTransaction'].signTransaction = () => new Promise(resolve => { release = resolve; });
  const pending = f.session.sign(f.payload, f.payload.review.digest);
  await assert.rejects(f.session.sign(f.payload, f.payload.review.digest), /WALLET_BUSY/);
  await Promise.resolve(); f.change(); release([]);
  await assert.rejects(pending, /WALLET_CHANGED/);
  assert.equal(f.session.address, null);
});
test('modified messages, forged signatures and malformed wallet responses fail verification', async () => {
  const { session, payload, wallet } = await fixture();
  const original = wallet.features['solana:signTransaction'].signTransaction;
  wallet.features['solana:signTransaction'].signTransaction = async (...requests) => {
    const out = await original(...requests); out[0].signedTransaction[out[0].signedTransaction.length - 1] ^= 1; return out;
  };
  await assert.rejects(session.sign(payload, payload.review.digest), /MESSAGE_DIFFERS/);
  wallet.features['solana:signTransaction'].signTransaction = async (...requests) => {
    const out = await original(...requests); out[0].signedTransaction[2] ^= 1; return out;
  };
  await assert.rejects(session.sign(payload, payload.review.digest), /INVALID_WALLET_SIGNATURE/);
  wallet.features['solana:signTransaction'].signTransaction = async () => [{}];
  await assert.rejects(session.sign(payload, payload.review.digest), /INVALID_WALLET_RESPONSE/);
});
test('wallet rejection/disconnect during connection cannot leave a usable session', async () => {
  const { session, wallet } = await fixture(); let resolve;
  wallet.features['standard:connect'].connect = () => new Promise(r => { resolve = r; });
  const pending = session.connect(wallet); await session.disconnect(); resolve({ accounts: wallet.accounts });
  await assert.rejects(pending, /WALLET_CONNECTION_REJECTED/); assert.equal(session.address, null);
});
test('server refuses to export offline or caller-reconstructed signing capabilities', async () => {
  const { review, owner } = await fixture();
  assert.throws(() => externalSigningPayload(review, review.digest, owner.address), /UNVERIFIED_WALLET_REQUEST/);
  assert.throws(() => externalSigningPayload(structuredClone(review), review.digest, owner.address), /NOT_ISSUED/);
});
test('signed-wire decoder rejects oversized, noncanonical and trailing bytes', async () => {
  const { review, session, payload } = await fixture();
  const [wire] = await session.sign(payload, payload.review.digest);
  for (const value of [wire + '\n', Buffer.concat([Buffer.from(wire, 'base64'), Buffer.from([1])]).toString('base64'), 'x'.repeat(1645), 'AAAA']) {
    await assert.rejects(verifySignedWireBatch(review, review.digest, [value]));
  }
});
test('standard discovery handles early/late registration, duplicate events and unregister', async () => {
  const { wallet } = await fixture(), surface = new EventTarget(); let found;
  surface.addEventListener('wallet-standard:app-ready', event => event.detail.register(wallet));
  const stop = discoverWallets(surface, items => { found = items; });
  assert.deepEqual(found, [wallet]);
  let unregister;
  const event = new Event('wallet-standard:register-wallet');
  Object.defineProperty(event, 'detail', { value: api => { unregister = api.register(wallet); } });
  surface.dispatchEvent(event); assert.equal(found.length, 1);
  unregister(); assert.equal(found.length, 1); // Duplicate registration cannot unregister someone else's entry.
  stop();
});

test('a wallet popup that never responds times out without blocking the next connection', async t => {
  const { session, payload, wallet } = await fixture();
  let timeout;
  t.mock.method(globalThis, 'setTimeout', fn => { timeout = fn; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  wallet.features['solana:signTransaction'].signTransaction = () => new Promise(() => {});
  const pending = session.sign(payload, payload.review.digest);
  timeout();
  await assert.rejects(pending, /WALLET_REQUEST_TIMED_OUT/);
  await session.connect(wallet);
  assert.ok(session.address);
});
