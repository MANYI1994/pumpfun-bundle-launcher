import { constants, openSync, closeSync, writeFileSync, fsyncSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PrivateDirectory } from './private-directory.js';
import { readRegularFile } from './files.js';
import { exactKeys, canonical, frozenJson, requireSafe, raw, validAddress, SafetyError } from './security.js';
import { DEVNET_GENESIS } from './network.js';
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
function id(value) { requireSafe(typeof value === 'string' && ID.test(value), 'INVALID_OPERATION_ID'); return value; }
function intentSchema(record) {
  exactKeys(record, ['version', 'id', 'cluster', 'genesis', 'action', 'payerAddress', 'signature', 'fingerprint', 'executionDigest', 'planDigest', 'lastValidBlockHeight', 'createdAt', 'expiresAt']);
  id(record.id); validAddress(record.payerAddress); raw(record.lastValidBlockHeight);
  requireSafe(record.version === 1 && record.cluster === 'devnet' && record.genesis === DEVNET_GENESIS && ['fund', 'buy'].includes(record.action), 'INVALID_JOURNAL_INTENT');
  requireSafe(['signature', 'fingerprint', 'executionDigest', 'planDigest'].every(k => typeof record[k] === 'string') && SIGNATURE.test(record.signature) && HASH.test(record.fingerprint) && HASH.test(record.executionDigest) && HASH.test(record.planDigest), 'INVALID_JOURNAL_INTENT');
  requireSafe(Number.isSafeInteger(record.createdAt) && record.createdAt > 0 && Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.createdAt, 'INVALID_JOURNAL_INTENT');
}
// Immutable, exclusive, fsynced events. A durable decision always precedes sending.
// Payer leases are monotonically numbered; no lock files are deleted after crashes.
export class ExecutionJournal {
  #directory;
  constructor(root) {
    const repo = path.resolve(import.meta.dirname, '..');
    requireSafe(typeof root === 'string' && path.resolve(root) !== repo && !path.resolve(root).startsWith(repo + path.sep), 'STATE_MUST_BE_OUTSIDE_REPOSITORY');
    this.#directory = new PrivateDirectory(root);
  }
  #names() {
    this.#directory.assert(); const names = readdirSync(this.#directory.root);
    requireSafe(names.length <= 10000 && names.every(n => /^(?:[a-f0-9-]{36}\.(?:intent|decision|ack|outcome)|(?:lease|release)-[1-9A-HJ-NP-Za-km-z]{32,44}-[0-9]{10})\.json$/.test(n)), 'UNEXPECTED_JOURNAL_FILES');
    return names;
  }
  #read(name, optional = false) {
    this.#directory.assert();
    try { return frozenJson(JSON.parse(readRegularFile(path.join(this.#directory.root, name), { privateFile: true }))); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  }
  #write(name, value) {
    this.#names();
    let fd;
    try { fd = openSync(path.join(this.#directory.root, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new SafetyError('JOURNAL_EVENT_ALREADY_EXISTS'); throw e; }
    try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
    this.#directory.assert();
    const dir = openSync(this.#directory.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  list() {
    return frozenJson(this.#names().filter(n => n.endsWith('.intent.json')).map(n => {
      const record = this.inspect(n.slice(0, -12));
      return { id: record.intent.id, payerAddress: record.intent.payerAddress, signature: record.intent.signature,
        state: record.outcome?.state ?? record.ack?.state ?? record.decision?.state ?? 'prepared' };
    }));
  }
  create(record) { intentSchema(record); this.#write(id(record.id) + '.intent.json', record); }
  inspect(operationId) {
    this.#names(); id(operationId);
    const intent = this.#read(operationId + '.intent.json'); intentSchema(intent);
    requireSafe(intent.id === operationId, 'JOURNAL_INTENT_MISMATCH');
    const events = {};
    for (const event of ['decision', 'ack', 'outcome']) {
      const record = this.#read(operationId + '.' + event + '.json', true);
      if (record) {
        exactKeys(record, ['id', 'state', 'observedAt']);
        requireSafe(record.id === operationId && Number.isSafeInteger(record.observedAt) && record.observedAt > 0, 'INVALID_JOURNAL_EVENT');
        requireSafe(({ decision: ['attempting', 'abandoned'], ack: ['accepted'], outcome: ['finalized', 'failed'] })[event].includes(record.state), 'INVALID_JOURNAL_EVENT');
      }
      events[event] = record;
    }
    requireSafe((!events.ack && !events.outcome) || events.decision?.state === 'attempting', 'INVALID_JOURNAL_SEQUENCE');
    return frozenJson({ intent, ...events });
  }
  decide(operationId, state) {
    const record = this.inspect(operationId);
    requireSafe(!record.decision && ['attempting', 'abandoned'].includes(state), 'OPERATION_ALREADY_DECIDED');
    if (state === 'attempting') requireSafe(this.#lease(record.intent), 'PAYER_LEASE_REQUIRED');
    this.#write(id(operationId) + '.decision.json', { id: operationId, state, observedAt: Date.now() });
  }
  acknowledge(operationId) {
    requireSafe(this.inspect(operationId).decision?.state === 'attempting', 'OPERATION_NOT_ATTEMPTED');
    this.#write(id(operationId) + '.ack.json', { id: operationId, state: 'accepted', observedAt: Date.now() });
  }
  finish(operationId, state) {
    const record = this.inspect(operationId);
    requireSafe(record.decision?.state === 'attempting' && ['finalized', 'failed'].includes(state), 'INVALID_FINAL_OUTCOME');
    if (!record.outcome) {
      try { this.#write(id(operationId) + '.outcome.json', { id: operationId, state, observedAt: Date.now() }); }
      catch (e) { if (e.code !== 'JOURNAL_EVENT_ALREADY_EXISTS' || this.inspect(operationId).outcome?.state !== state) throw e; }
    }
    else requireSafe(record.outcome.state === state, 'FINAL_OUTCOME_CONFLICT');
    this.release(operationId);
  }
  acquire(operationId) {
    const { intent, decision } = this.inspect(operationId);
    requireSafe(!decision, 'OPERATION_ALREADY_DECIDED');
    const names = this.#names().filter(n => n.startsWith('lease-' + intent.payerAddress + '-')).sort();
    let sequence = 0;
    if (names.length) {
      const last = names.at(-1), lease = this.#read(last); exactKeys(lease, ['id']); id(lease.id);
      const released = this.#read(last.replace('lease-', 'release-'), true);
      requireSafe(released && canonical(released) === canonical(lease), 'PAYER_HAS_UNRESOLVED_OPERATION');
      sequence = Number(last.slice(-15, -5));
    }
    requireSafe(sequence < 9999999999, 'JOURNAL_LEASE_LIMIT');
    this.#write(`lease-${intent.payerAddress}-${String(sequence + 1).padStart(10, '0')}.json`, { id: operationId });
  }
  #lease(intent) {
    const names = this.#names().filter(n => n.startsWith('lease-' + intent.payerAddress + '-')).sort();
    if (!names.length) return null;
    const last = names.at(-1), owner = this.#read(last); exactKeys(owner, ['id']); id(owner.id);
    return owner.id === intent.id && !this.#read(last.replace('lease-', 'release-'), true) ? last : null;
  }
  release(operationId) {
    const record = this.inspect(operationId);
    requireSafe(record.decision?.state === 'abandoned' || record.outcome, 'UNRESOLVED_PAYER_LEASE');
    const name = this.#lease(record.intent);
    if (name) {
      const released = name.replace('lease-', 'release-');
      try { this.#write(released, { id: operationId }); }
      catch (e) { if (e.code !== 'JOURNAL_EVENT_ALREADY_EXISTS' || this.#read(released).id !== operationId) throw e; }
    }
  }
}
