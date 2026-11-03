import { requireSafe, SafetyError, frozenJson } from './security.js';

// Read-only reconciliation: submission is deliberately not implemented here.
// No retry or alternate RPC rebroadcast can silently weaken bundle guarantees.
export async function reconcile(rpc, signatures, { timeoutMs = 20000, pollMs = 1000, now = () => performance.now(), wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  signatures = frozenJson(signatures);
  requireSafe(Array.isArray(signatures) && signatures.length > 0 && signatures.length <= 5 && signatures.every(s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)) && new Set(signatures).size === signatures.length, 'INVALID_SIGNATURES');
  requireSafe(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000 && Number.isSafeInteger(pollMs) && pollMs >= 1 && pollMs <= 5000, 'INVALID_POLL_LIMIT');
  const deadline = now() + timeoutMs;
  const maxPolls = Math.min(60, Math.ceil(timeoutMs / pollMs));
  for (let attempt = 0; attempt < maxPolls && now() < deadline; attempt++) {
    const result = await rpc.read('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    requireSafe(Array.isArray(result?.value) && result.value.length === signatures.length, 'INVALID_STATUS_RESPONSE');
    requireSafe(result.value.every(v => v === null || (typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'err') && ['processed', 'confirmed', 'finalized'].includes(v.confirmationStatus) && (v.err === null || typeof v.err === 'string' || (typeof v.err === 'object' && !Array.isArray(v.err))))), 'INVALID_STATUS_RESPONSE');
    if (result.value.some(v => v !== null && v.err !== null)) throw new SafetyError('TRANSACTION_FAILED');
    if (result.value.every(v => v?.confirmationStatus === 'finalized')) return frozenJson({ state: 'finalized', signatures });
    await wait(pollMs);
  }
  return frozenJson({ state: 'unknown', signatures, resubmit: false });
}
