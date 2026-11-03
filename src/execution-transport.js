import { getTransactionDecoder } from '@solana/kit';
import { Rpc } from './network.js';
import { inspectExecutionPermit, consumeExecutionPermit } from './transactions.js';
import { enforceFundingBudget } from './plans.js';
import { ExecutionJournal } from './journal.js';
import { frozenJson, requireSafe, SafetyError } from './security.js';
const nativeFetch = globalThis.fetch.bind(globalThis);
// This transport handles native funding only; no arbitrary instruction/send API.
export class DevnetExecutionTransport {
  #rpc = new Rpc(); #proofs = new WeakMap(); #id = 0;
  get rpc() { return this.#rpc; }
  async simulate(permit) {
    const d = inspectExecutionPermit(permit), tx = d.transactions[0];
    await this.#rpc.verifyCluster();
    const valid = await this.#rpc.read('isBlockhashValid', [d.blockhash, { commitment: 'confirmed' }]);
    const height = await this.#rpc.read('getBlockHeight', [{ commitment: 'confirmed' }]);
    requireSafe(valid?.value === true && Number.isSafeInteger(height) && height >= 0 && BigInt(height) <= BigInt(d.lastValidBlockHeight), 'BLOCKHASH_INVALID_OR_EXPIRED');
    const decoded = getTransactionDecoder().decode(Buffer.from(tx.wireBase64, 'base64'));
    const fee = await this.#rpc.read('getFeeForMessage', [Buffer.from(decoded.messageBytes).toString('base64'), { commitment: 'confirmed' }]);
    const balance = await this.#rpc.read('getBalance', [d.plan.payerAddress]);
    requireSafe(Number.isSafeInteger(fee?.value) && fee.value >= 0 && Number.isSafeInteger(balance?.value) && balance.value >= 0, 'INVALID_FEE_OR_BALANCE_RESPONSE');
    requireSafe(String(fee.value) === d.budget.feeLamports, 'FEE_CHANGED_REVIEW_REQUIRED');
    const budget = enforceFundingBudget(d.plan, { feeLamports: String(fee.value), balanceLamports: String(balance.value) });
    const simulated = await this.#rpc.read('simulateTransaction', [tx.wireBase64, { encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false }]);
    requireSafe(simulated?.value && Object.hasOwn(simulated.value, 'err') && simulated.value.err === null && simulated.value.replacementBlockhash == null
      && Number.isSafeInteger(simulated.context?.slot) && simulated.context.slot >= 0, 'SIMULATION_REJECTED');
    inspectExecutionPermit(permit);
    const proof = frozenJson({ executionDigest: d.executionDigest, signature: tx.signature, simulationSlot: simulated.context.slot,
      expiresAt: Math.min(d.expiresAt, Date.now() + 5000), budget });
    this.#proofs.set(proof, { permit, descriptor: d });
    return proof;
  }
  async submit(proof, journal) {
    const record = this.#proofs.get(proof);
    requireSafe(record && Date.now() < proof.expiresAt, 'SIMULATION_NOT_ISSUED_OR_EXPIRED');
    requireSafe(journal instanceof ExecutionJournal, 'DURABLE_JOURNAL_REQUIRED');
    const d = inspectExecutionPermit(record.permit), tx = d.transactions[0];
    const { intent } = journal.inspect(d.plan.id);
    requireSafe(intent.executionDigest === d.executionDigest && intent.signature === tx.signature && intent.fingerprint === tx.fingerprint
      && intent.payerAddress === d.plan.payerAddress, 'JOURNAL_EXECUTION_MISMATCH');
    this.#proofs.delete(proof);
    journal.decide(d.plan.id, 'attempting'); // Must succeed and fsync BEFORE any send.
    consumeExecutionPermit(record.permit);
    const id = ++this.#id;
    try {
      const response = await nativeFetch('https://api.devnet.solana.com/', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'sendTransaction', params: [tx.wireBase64,
          { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: proof.simulationSlot }] }) });
      requireSafe(response.ok && response.body, 'SUBMISSION_UNCERTAIN');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; requireSafe(size <= 65536, 'SUBMISSION_UNCERTAIN'); chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireSafe(payload.jsonrpc === '2.0' && payload.id === id && !payload.error && payload.result === tx.signature, 'SUBMISSION_UNCERTAIN');
      journal.acknowledge(d.plan.id);
      return frozenJson({ id: d.plan.id, signature: tx.signature, state: 'accepted', finalized: false, resubmit: false });
    } catch { throw new SafetyError('SUBMISSION_UNCERTAIN_CHECK_ORIGINAL_SIGNATURE'); }
  }
}
