import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromPrivateKeyBytes, signTransaction, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit';

// Isolated test-process RPC replacement. No real endpoint or broadcast is used.
let scenario;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://api.devnet.solana.com/');
  const request = JSON.parse(options.body); scenario.calls.push(request);
  let result;
  switch (request.method) {
    case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break;
    case 'getLatestBlockhash': result = { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } }; break;
    case 'getFeeForMessage': result = { value: scenario.fee }; break;
    case 'getBalance': result = { value: scenario.balance }; break;
    case 'isBlockhashValid': result = { value: scenario.valid }; break;
    case 'getBlockHeight': result = request.params[0].commitment === 'finalized' ? scenario.finalHeight : scenario.height; break;
    case 'simulateTransaction':
      assert.equal(request.params[0], scenario.wire);
      assert.deepEqual(request.params[1], { encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false });
      result = { context: { slot: 51 }, value: { err: scenario.simulationError, replacementBlockhash: null } }; break;
    case 'sendTransaction':
      assert.equal(request.params[0], scenario.wire);
      assert.deepEqual(request.params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: 51 });
      assert.equal(scenario.journal.inspect(scenario.operationId).decision.state, 'attempting');
      if (scenario.sendError) throw new Error('Upstream failure with diagnostics that must not leak');
      result = scenario.signature; break;
    case 'getSignatureStatuses':
      assert.deepEqual(request.params, [[scenario.signature], { searchTransactionHistory: true }]);
      result = { context: { slot: 55 }, value: [scenario.status] }; break;
    default: throw new Error('Unexpected RPC');
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
};
const { Rpc } = await import('../src/network.js');
const { fundingPlan } = await import('../src/plans.js');
const { prepareFundingReview, compileFunding, verifySignedWireBatch } = await import('../src/transactions.js');
const { NativeTransferExecutor } = await import('../src/executor.js');
const { ExecutionJournal } = await import('../src/journal.js');
const { DevnetExecutionTransport } = await import('../src/execution-transport.js');
test.after(() => { globalThis.fetch = originalFetch; });
function setup(t) {
  scenario = { calls: [], fee: 5000, balance: 20000000, height: 80, finalHeight: 70, valid: true, simulationError: null, status: null, sendError: false };
  const root = mkdtempSync(path.join(os.tmpdir(), 'launcher-execution-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = new ExecutionJournal(root); scenario.journal = journal;
  return { root, journal, executor: new NativeTransferExecutor(journal) };
}
async function approved() {
  const seed = new Uint8Array(32); seed[0] = 119;
  const owner = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const envelope = fundingPlan({ payerAddress: owner.address, wallets: [{ id: 'recipient', address: 'So11111111111111111111111111111111111111112', lamports: '1000000' }] });
  const context = await new Rpc().getBlockhashContext();
  const review = await prepareFundingReview(envelope, envelope.digest, context);
  const tx = compileFunding(envelope, envelope.digest, { blockhash: context.blockhash, lastValidBlockHeight: BigInt(context.lastValidBlockHeight) });
  const signed = await signTransaction([owner.keyPair], tx);
  scenario.wire = getBase64EncodedWireTransaction(signed);
  const batch = await verifySignedWireBatch(review, review.digest, [scenario.wire]);
  scenario.signature = batch.transactions[0].signature; scenario.operationId = envelope.plan.id;
  return { batch, id: envelope.plan.id, owner };
}
const sends = () => scenario.calls.filter(c => c.method === 'sendTransaction').length;
test('executor simulates unchanged bytes, durably records before sending, and recovers after restart', async t => {
  const { root, journal, executor } = setup(t), { batch, id } = await approved();
  const ticket = await executor.prepare(batch, batch.executionDigest);
  assert.equal(ticket.submitted, false); assert.equal(sends(), 0);
  const result = await executor.submit(ticket, ticket.executionDigest);
  assert.equal(result.state, 'accepted'); assert.equal(result.finalized, false); assert.equal(sends(), 1);
  const restarted = new NativeTransferExecutor(new ExecutionJournal(root));
  assert.equal((await restarted.recover(id)).state, 'unknown');
  scenario.status = { slot: 55, err: null, confirmationStatus: 'finalized' };
  assert.equal((await restarted.recover(id)).state, 'finalized');
  assert.equal((await restarted.recover(id)).state, 'finalized');
  assert.equal(sends(), 1); assert.equal(journal.list()[0].state, 'finalized');
  for (const name of readdirSync(root)) assert.ok(!readFileSync(path.join(root, name), 'utf8').includes(scenario.wire));
});
test('uncertain submission is never retried and an expired missing signature keeps the payer reserved', async t => {
  const { root, executor } = setup(t), { batch, id } = await approved();
  const ticket = await executor.prepare(batch, batch.executionDigest); scenario.sendError = true;
  await assert.rejects(executor.submit(ticket, ticket.executionDigest), /^SafetyError: SUBMISSION_UNCERTAIN_CHECK_ORIGINAL_SIGNATURE$/);
  await assert.rejects(executor.submit(ticket, ticket.executionDigest), /TICKET_NOT_ISSUED/);
  const restarted = new NativeTransferExecutor(new ExecutionJournal(root)); scenario.finalHeight = 200;
  const unknown = await restarted.recover(id); assert.equal(unknown.state, 'expired-unknown'); assert.equal(unknown.payerReserved, true);
  const next = await approved();
  await assert.rejects(restarted.prepare(next.batch, next.batch.executionDigest), /PAYER_HAS_UNRESOLVED/);
  assert.equal(sends(), 1);
  scenario.signature = batch.transactions[0].signature;
  scenario.status = { slot: 55, err: null, confirmationStatus: 'finalized' };
  assert.equal((await restarted.recover(id)).state, 'finalized');
});
test('pre-send cancellation survives restart and prevents an old live controller from sending', async t => {
  const { root, executor } = setup(t), { batch, id } = await approved();
  const ticket = await executor.prepare(batch, batch.executionDigest);
  const restarted = new NativeTransferExecutor(new ExecutionJournal(root));
  assert.equal((await restarted.recover(id)).state, 'abandoned-before-submission');
  await assert.rejects(executor.submit(ticket, ticket.executionDigest), /OPERATION_ALREADY_DECIDED/);
  assert.equal(sends(), 0);
  const next = await approved();
  assert.ok(await restarted.prepare(next.batch, next.batch.executionDigest));
});
test('failed simulation, changed fee, low balance and expired blockhash prevent submission', async t => {
  const { executor } = setup(t);
  for (const issue of ['simulation', 'fee', 'balance', 'height', 'blockhash']) {
    const f = await approved();
    if (issue === 'simulation') scenario.simulationError = { InstructionError: [0, 'Custom'] };
    if (issue === 'fee') scenario.fee = 6000;
    if (issue === 'balance') scenario.balance = 1000000;
    if (issue === 'height') scenario.height = 101;
    if (issue === 'blockhash') scenario.valid = false;
    await assert.rejects(executor.prepare(f.batch, f.batch.executionDigest));
    await executor.recover(f.id);
    scenario.simulationError = null; scenario.fee = 5000; scenario.balance = 20000000; scenario.height = 80; scenario.valid = true;
  }
  assert.equal(sends(), 0);
});
test('reconstructed approvals, tickets, proofs and a failed durable decision cannot authorize sending', async t => {
  const { executor, journal } = setup(t), { batch } = await approved();
  await assert.rejects(executor.prepare(structuredClone(batch), batch.executionDigest), /NOT_VERIFIED/);
  await assert.rejects(executor.prepare(batch, '0'.repeat(64)), /NOT_VERIFIED/);
  const ticket = await executor.prepare(batch, batch.executionDigest);
  await assert.rejects(executor.submit(structuredClone(ticket), ticket.executionDigest), /NOT_ISSUED/);
  await assert.rejects(new DevnetExecutionTransport().submit({}, journal), /SIMULATION_NOT_ISSUED/);
  t.mock.method(journal, 'decide', () => { throw new Error('Simulated disk failure'); });
  await assert.rejects(executor.submit(ticket, ticket.executionDigest), /disk failure/); assert.equal(sends(), 0);
});
test('processed/confirmed errors are not treated as final failures; finalized errors are', async t => {
  const { executor } = setup(t), { batch, id } = await approved();
  const ticket = await executor.prepare(batch, batch.executionDigest); await executor.submit(ticket, ticket.executionDigest);
  for (const confirmationStatus of ['processed', 'confirmed']) {
    scenario.status = { slot: 55, err: { InstructionError: [0, 'Custom'] }, confirmationStatus };
    assert.equal((await executor.recover(id)).state, 'pending');
  }
  scenario.status = { slot: 55, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' };
  assert.equal((await executor.recover(id)).state, 'failed'); assert.equal(sends(), 1);
});

test('execution-mode HTTP API requires simulation and separate approval; normal mode still cannot send', async t => {
  const { root } = setup(t), { owner } = await approved();
  const { startWalletServer } = await import('../src/wallet-server.js');
  const server = await startWalletServer({ port: 0, journalRoot: root }); t.after(() => server.close());
  const native = originalFetch;
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('session');
  const post = async (route, data) => {
    const res = await native(server.origin + route, { method: 'POST', headers: { origin: server.origin, 'x-launcher-session': token, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await post('/api/mode', {})).data.executionEnabled, true);
  assert.equal((await post('/api/submit', { executionDigest: '0'.repeat(64) })).status, 400);
  const review = (await post('/api/review', { payerAddress: owner.address, destinationAddress: 'So11111111111111111111111111111111111111112', lamports: '1000000' })).data;
  const signed = await signTransaction([owner.keyPair], getTransactionDecoder().decode(Buffer.from(review.unsignedTransactions[0], 'base64')));
  scenario.wire = getBase64EncodedWireTransaction(signed);
  const verified = (await post('/api/verify', { reviewDigest: review.review.digest, signedTransactions: [scenario.wire] })).data;
  scenario.signature = (await import('@solana/kit')).getSignatureFromTransaction(signed);
  scenario.operationId = verified.operationId;
  const prepared = await post('/api/simulate', { executionDigest: verified.executionDigest });
  assert.equal(prepared.status, 200); assert.equal(sends(), 0);
  const sent = await post('/api/submit', { executionDigest: verified.executionDigest });
  assert.equal(sent.status, 200); assert.equal(sent.data.state, 'accepted'); assert.equal(sends(), 1);
  assert.equal((await post('/api/submit', { executionDigest: verified.executionDigest })).status, 400);
  scenario.status = { slot: 55, err: null, confirmationStatus: 'finalized' };
  assert.equal((await post('/api/recover', { operationId: verified.operationId })).data.state, 'finalized');
  assert.equal((await post('/api/operations', {})).data.operations[0].state, 'finalized');
  assert.equal(sends(), 1);
});
