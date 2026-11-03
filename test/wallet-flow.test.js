import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getTransactionDecoder, getBase64EncodedWireTransaction, signTransaction } from '@solana/kit';
import { WalletSession, fromBase64 } from '../web/wallet.js';

test('HTTP review → external wallet → server verification works with mocked devnet RPC and never sends', async t => {
  // This test replaces fetch before network.js captures it. It is not live-chain evidence.
  const native = globalThis.fetch, methods = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.devnet.solana.com/') return native(url, options);
    const p = JSON.parse(options.body); methods.push(p.method);
    const result = {
      getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      getLatestBlockhash: { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } },
      getFeeForMessage: { value: 5000 }, getBalance: { value: 20000000 },
    }[p.method];
    assert.notEqual(result, undefined, 'Unexpected RPC, especially a broadcast method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }));
  };
  t.after(() => { globalThis.fetch = native; });
  const { startWalletServer } = await import('../src/wallet-server.js');
  const instance = await startWalletServer({ port: 0 }); t.after(() => instance.close());
  const token = new URLSearchParams(new URL(instance.url).hash.slice(1)).get('session');
  const seed = new Uint8Array(32); seed[0] = 91;
  const owner = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const account = { address: owner.address, publicKey: getAddressEncoder().encode(owner.address), chains: ['solana:devnet'], features: ['solana:signTransaction'] };
  let signingCalls = 0;
  const wallet = { version: '1.0.0', chains: ['solana:devnet'], accounts: [account], features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'standard:events': { version: '1.0.0', on: () => () => {} },
    'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async (...requests) => {
      signingCalls++;
      return Promise.all(requests.map(async request => ({ signedTransaction: fromBase64(getBase64EncodedWireTransaction(await signTransaction([owner.keyPair], getTransactionDecoder().decode(request.transaction)))) })));
    } },
  } };
  const post = async (route, data) => {
    const r = await native(instance.origin + route, { method: 'POST', headers: { origin: instance.origin, 'x-launcher-session': token, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  };
  const request = { payerAddress: owner.address, destinationAddress: 'So11111111111111111111111111111111111111112', lamports: '1000000' };
  const { status, data: payload } = await post('/api/review', request);
  assert.equal(status, 200);
  assert.equal(payload.review.details.budget.feeLamports, '5000');
  const session = new WalletSession(); await session.connect(wallet);
  const wires = await session.sign(payload, payload.review.digest);
  const verified = await post('/api/verify', { reviewDigest: payload.review.digest, signedTransactions: wires });
  assert.equal(verified.status, 200); assert.equal(verified.data.verified, true); assert.equal(verified.data.broadcast, false);
  assert.equal('transactions' in verified.data, false); // Signed transactions are not returned or persisted by the HTTP app.
  assert.equal((await post('/api/verify', { reviewDigest: payload.review.digest, signedTransactions: wires })).status, 400);
  const next = (await post('/api/review', request)).data;
  await post('/api/cancel', {});
  assert.equal((await post('/api/verify', { reviewDigest: next.review.digest, signedTransactions: wires })).status, 400);
  assert.equal(signingCalls, 1);
  assert.deepEqual([...new Set(methods)].sort(), ['getBalance', 'getFeeForMessage', 'getGenesisHash', 'getLatestBlockhash']);
});
