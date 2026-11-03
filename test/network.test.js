import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, DEVNET_GENESIS, assertDevnetContext } from '../src/network.js';
import { reconcile } from '../src/settlement.js';
const response = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } });
test('devnet genesis pin is the complete public cluster hash', () => {
  assert.equal(DEVNET_GENESIS, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
});
test('RPC endpoint policy rejects remote sinks and URL tricks', () => {
  for (const url of ['http://api.devnet.solana.com', 'https://api.devnet.solana.com.evil.test', 'https://user:pass@api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'https://127.0.0.1', 'https://api.devnet.solana.com/path', 'https://api.devnet.solana.com?secret=abc']) assert.throws(() => new Rpc({ url }));
});
test('only public read parameters reach approved transport and redirects are forbidden', async () => {
  const seen = [];
  const rpc = new Rpc({ fetchImpl: async (url, options) => { const request = JSON.parse(options.body); seen.push({ url, options, request }); return response(request.id, request.method === 'getGenesisHash' ? DEVNET_GENESIS : { value: 1 }); } });
  await rpc.read('getBalance', ['11111111111111111111111111111111']);
  assert.equal(seen.length, 2); assert.equal(seen[0].options.redirect, 'error'); assert.equal(seen[0].url, 'https://api.devnet.solana.com/');
  await assert.rejects(rpc.read('sendTransaction', ['data']), /RPC_METHOD_NOT_ALLOWED/);
  await assert.rejects(rpc.send(), /BROADCAST_DISABLED/);
});
test('wrong cluster stops requests before account access', async () => {
  let count = 0;
  const rpc = new Rpc({ fetchImpl: async (_url, o) => { count++; return response(JSON.parse(o.body).id, 'mainnet'); } });
  await assert.rejects(rpc.read('getBalance', ['11111111111111111111111111111111']), /WRONG_CLUSTER/); assert.equal(count, 1);
});
test('error responses never propagate remote secrets', async () => {
  const rpc = new Rpc({ fetchImpl: async (_u, o) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(o.body).id, error: { message: 'sensitive remote text' } })) });
  await assert.rejects(rpc.verifyCluster(), e => e.message === 'RPC_RESPONSE_REJECTED');
});
test('oversized replies rejected', async () => {
  const rpc = new Rpc({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(rpc.verifyCluster(), /RPC_RESPONSE_TOO_LARGE/);
});
test('unrecognized payloads are rejected before transport rather than forwarding arbitrary files', async () => {
  let contacted = false;
  const rpc = new Rpc({ fetchImpl: async () => { contacted = true; throw new Error('must not call'); } });
  await assert.rejects(rpc.read('getBalance', ['a private secret string']));
  await assert.rejects(rpc.read('getGenesisHash', ['a private secret string']));
  await assert.rejects(rpc.read('simulateTransaction', ['a private secret string']));
  assert.equal(contacted, false);
});
test('account reads reject the wrong owner and noncanonical encoded data', async () => {
  const pubkey = '11111111111111111111111111111111', expected = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  for (const value of [{ owner: pubkey, executable: false, data: ['AA==', 'base64'] }, { owner: expected, executable: false, data: ['not-base64!', 'base64'] }]) {
    const rpc = new Rpc({ fetchImpl: async (_url, o) => { const p = JSON.parse(o.body); return response(p.id, p.method === 'getGenesisHash' ? DEVNET_GENESIS : { value }); } });
    await assert.rejects(rpc.account(pubkey, expected), /ACCOUNT_OWNER_OR_DATA_MISMATCH/);
  }
});
test('RPC parameters cannot be swapped while genesis verification is pending', async () => {
  let releaseGenesis;
  const bodies = [];
  const rpc = new Rpc({ fetchImpl: async (_url, o) => {
    const p = JSON.parse(o.body); bodies.push(p);
    if (p.method === 'getGenesisHash') return new Promise(resolve => { releaseGenesis = () => resolve(response(p.id, DEVNET_GENESIS)); });
    return response(p.id, { value: 1 });
  } });
  const params = ['11111111111111111111111111111111'];
  const pending = rpc.read('getBalance', params);
  params[0] = 'must-never-be-forwarded';
  releaseGenesis(); await pending;
  assert.deepEqual(bodies[1].params, ['11111111111111111111111111111111']);
});
test('blockhash contexts require cluster verification and a validated lifetime response', async () => {
  const calls = [];
  const rpc = new Rpc({ fetchImpl: async (_u, o) => {
    const p = JSON.parse(o.body); calls.push(p.method);
    return response(p.id, p.method === 'getGenesisHash' ? DEVNET_GENESIS : { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } });
  } });
  const context = await rpc.getBlockhashContext();
  assert.deepEqual(calls, ['getGenesisHash', 'getLatestBlockhash']);
  assert.throws(() => assertDevnetContext(context), /UNVERIFIED_OR_EXPIRED/);
  assert.throws(() => assertDevnetContext(structuredClone(context)), /UNVERIFIED_OR_EXPIRED/);
  const bad = new Rpc({ fetchImpl: async (_u, o) => { const p = JSON.parse(o.body); return response(p.id, p.method === 'getGenesisHash' ? DEVNET_GENESIS : { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: -1 } }); } });
  await assert.rejects(bad.getBlockhashContext(), /INVALID_BLOCKHASH_LIFETIME/);
});
test('settlement never treats accepted, pending or timeout as success', async () => {
  let time = 0;
  const signature = '1'.repeat(88);
  const rpc = { read: async () => ({ value: [null] }) };
  const result = await reconcile(rpc, [signature], { timeoutMs: 3, pollMs: 1, now: () => time, wait: async ms => { time += ms; } });
  assert.equal(result.state, 'unknown'); assert.equal(result.resubmit, false);
  await assert.rejects(reconcile({ read: async () => ({ value: [{ err: { failed: true }, confirmationStatus: 'processed' }] }) }, [signature]), /TRANSACTION_FAILED/);
  assert.equal((await reconcile({ read: async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }) }, [signature])).state, 'finalized');
});
test('settlement cannot attribute a finalized result to caller-swapped signatures', async () => {
  const signatures = ['1'.repeat(88)]; let release;
  const rpc = { read: async () => new Promise(resolve => { release = () => resolve({ value: [{ err: null, confirmationStatus: 'finalized' }] }); }) };
  const pending = reconcile(rpc, signatures);
  signatures[0] = '2'.repeat(88); release();
  const result = await pending;
  assert.deepEqual(result.signatures, ['1'.repeat(88)]); assert.ok(Object.isFrozen(result.signatures));
});
test('malformed finalized statuses cannot bypass explicit error/status validation', async () => {
  for (const entry of [{ confirmationStatus: 'finalized' }, { confirmationStatus: 'finalized', err: false }, { confirmationStatus: 'invented', err: null }]) await assert.rejects(reconcile({ read: async () => ({ value: [entry] }) }, ['1'.repeat(88)]), /INVALID_STATUS_RESPONSE/);
});

test('mainnet inspection pins its endpoint and cannot issue signing contexts', async () => {
  const requests = [];
  const rpc = new Rpc({ profile: 'mainnet', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, method: request.method });
    return response(request.id, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  } });
  await rpc.verifyCluster();
  await assert.rejects(rpc.getBlockhashContext(), /PROFILE_EXECUTION_DISABLED/);
  await assert.rejects(rpc.read('simulateTransaction', []), /RPC_METHOD_NOT_ALLOWED/);
  await assert.rejects(rpc.send(), /BROADCAST_DISABLED/);
  assert.deepEqual(requests, [{ url: 'https://api.mainnet-beta.solana.com/', method: 'getGenesisHash' }]);
  assert.throws(() => new Rpc({ profile: 'mainnet', url: 'https://api.devnet.solana.com/' }), /RPC_ENDPOINT_NOT_ALLOWED/);
});
