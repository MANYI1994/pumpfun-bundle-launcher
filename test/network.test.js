import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, DEVNET_GENESIS } from '../src/network.js';
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
test('settlement never treats accepted, pending or timeout as success', async () => {
  let time = 0;
  const signature = '1'.repeat(88);
  const rpc = { read: async () => ({ value: [null] }) };
  const result = await reconcile(rpc, [signature], { timeoutMs: 3, pollMs: 1, now: () => time, wait: async ms => { time += ms; } });
  assert.equal(result.state, 'unknown'); assert.equal(result.resubmit, false);
  await assert.rejects(reconcile({ read: async () => ({ value: [{ err: { failed: true } }] }) }, [signature]), /TRANSACTION_FAILED/);
  assert.equal((await reconcile({ read: async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }) }, [signature])).state, 'finalized');
});
