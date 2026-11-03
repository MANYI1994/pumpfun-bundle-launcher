import { claimVerifiedExecution, inspectExecutionPermit } from './transactions.js';
import { DevnetExecutionTransport } from './execution-transport.js';
import { ExecutionJournal } from './journal.js';
import { DEVNET_GENESIS } from './network.js';
import { frozenJson, requireSafe, equalDigest } from './security.js';

// Orchestration only. Signing stays external; recovery never calls submission.
export class NativeTransferExecutor {
  #journal; #transport; #tickets = new WeakMap();
  constructor(journal) {
    requireSafe(journal instanceof ExecutionJournal, 'DURABLE_JOURNAL_REQUIRED');
    this.#journal = journal; this.#transport = new DevnetExecutionTransport();
  }
  async prepare(verifiedBatch, confirmation) {
    const permit = claimVerifiedExecution(verifiedBatch, confirmation), d = inspectExecutionPermit(permit), tx = d.transactions[0];
    this.#journal.create({ version: 1, id: d.plan.id, cluster: 'devnet', genesis: DEVNET_GENESIS, action: 'fund',
      payerAddress: d.plan.payerAddress, signature: tx.signature, fingerprint: tx.fingerprint,
      executionDigest: d.executionDigest, planDigest: d.planDigest, lastValidBlockHeight: d.lastValidBlockHeight,
      createdAt: Date.now(), expiresAt: d.expiresAt });
    this.#journal.acquire(d.plan.id);
    // A simultaneous recovery cancellation wins via the exclusive decision file.
    requireSafe(!this.#journal.inspect(d.plan.id).decision, 'OPERATION_ALREADY_DECIDED');
    const simulation = await this.#transport.simulate(permit);
    const ticket = frozenJson({ id: d.plan.id, executionDigest: d.executionDigest, signature: tx.signature,
      expiresAt: d.expiresAt, simulationSlot: simulation.simulationSlot, budget: simulation.budget, submitted: false });
    this.#tickets.set(ticket, { permit });
    return ticket;
  }
  async submit(ticket, confirmation) {
    const record = this.#tickets.get(ticket);
    requireSafe(record && equalDigest(confirmation, ticket.executionDigest), 'EXECUTION_TICKET_NOT_ISSUED_OR_APPROVED');
    this.#tickets.delete(ticket);
    // Repeat preflight immediately before the one allowed send.
    const simulation = await this.#transport.simulate(record.permit);
    return this.#transport.submit(simulation, this.#journal);
  }
  async recover(operationId) {
    let record = this.#journal.inspect(operationId);
    if (record.outcome) { this.#journal.release(operationId); return frozenJson({ id: operationId, state: record.outcome.state, resubmit: false }); }
    if (!record.decision) {
      try { this.#journal.decide(operationId, 'abandoned'); }
      catch { record = this.#journal.inspect(operationId); if (!record.decision) throw new Error('RECOVERY_DECISION_FAILED'); }
      record = this.#journal.inspect(operationId);
    }
    if (record.decision.state === 'abandoned') {
      this.#journal.release(operationId);
      return frozenJson({ id: operationId, state: 'abandoned-before-submission', resubmit: false });
    }
    const rpc = this.#transport.rpc;
    await rpc.verifyCluster();
    const statuses = await rpc.read('getSignatureStatuses', [[record.intent.signature], { searchTransactionHistory: true }]);
    requireSafe(Number.isSafeInteger(statuses?.context?.slot) && statuses.context.slot >= 0 && Array.isArray(statuses?.value) && statuses.value.length === 1, 'INVALID_STATUS_RESPONSE');
    const status = statuses.value[0];
    requireSafe(status === null || (status && !Array.isArray(status) && Number.isSafeInteger(status.slot) && status.slot >= 0 && Object.hasOwn(status, 'err') && ['processed', 'confirmed', 'finalized'].includes(status.confirmationStatus)
      && (status.err === null || typeof status.err === 'string' || (typeof status.err === 'object' && !Array.isArray(status.err)))), 'INVALID_STATUS_RESPONSE');
    if (status?.confirmationStatus === 'finalized') {
      const state = status.err === null ? 'finalized' : 'failed';
      this.#journal.finish(operationId, state);
      return frozenJson({ id: operationId, signature: record.intent.signature, state, resubmit: false });
    }
    const height = await rpc.read('getBlockHeight', [{ commitment: 'finalized' }]);
    requireSafe(Number.isSafeInteger(height) && height >= 0, 'INVALID_BLOCK_HEIGHT_RESPONSE');
    // Absence on one RPC is not proof that nothing landed. Keep the payer lease.
    return frozenJson({ id: operationId, signature: record.intent.signature,
      state: status ? 'pending' : BigInt(height) > BigInt(record.intent.lastValidBlockHeight) ? 'expired-unknown' : 'unknown',
      resubmit: false, payerReserved: true });
  }
}
