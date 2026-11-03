import { Rpc } from './network.js';
import { exactKeys, frozenJson, raw, requireSafe } from './security.js';

export async function checkBundleStatus(input, rpc = new Rpc()) {
  exactKeys(input, ['digest', 'signatures', 'lastValidBlockHeight']);
  requireSafe(typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest), 'INVALID_BUNDLE_DIGEST');
  const signatures = frozenJson(input.signatures);
  requireSafe(Array.isArray(signatures) && signatures.length >= 2 && signatures.length <= 5 &&
    signatures.every(value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) &&
    new Set(signatures).size === signatures.length, 'INVALID_BUNDLE_SIGNATURES');
  const lastHeight = raw(input.lastValidBlockHeight);
  const digest = input.digest;
  const result = await rpc.read('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
  requireSafe(Array.isArray(result?.value) && result.value.length === signatures.length, 'INVALID_STATUS_RESPONSE');
  const transactions = result.value.map((value, index) => {
    const signature = signatures[index];
    if (value === null) return { signature, state: 'unseen' };
    requireSafe(value && Object.hasOwn(value, 'err') && Number.isSafeInteger(value.slot) && value.slot >= 0 &&
      ['processed', 'confirmed', 'finalized'].includes(value.confirmationStatus), 'INVALID_STATUS_RESPONSE');
    const state = value.confirmationStatus === 'finalized'
      ? (value.err === null ? 'finalized' : 'failed')
      : 'pending';
    return { signature, state, slot: value.slot };
  });
  const finalized = transactions.filter(tx => tx.state === 'finalized');
  let state = 'unresolved';
  if (finalized.length === transactions.length) {
    state = new Set(finalized.map(tx => tx.slot)).size === 1 ? 'finalized-same-slot' : 'finalized-different-slots';
  } else if (finalized.length) {
    state = 'partially-finalized';
  } else if (transactions.some(tx => tx.state === 'failed')) {
    state = 'finalized-failure-observed';
  } else if (transactions.every(tx => tx.state === 'unseen')) {
    const height = await rpc.read('getBlockHeight', [{ commitment: 'finalized' }]);
    requireSafe(Number.isSafeInteger(height) && height >= 0, 'INVALID_BLOCK_HEIGHT_RESPONSE');
    if (BigInt(height) > lastHeight) state = 'expired-history-unresolved';
  }
  return frozenJson({ digest, cluster: 'devnet', state, transactions, resubmit: false });
}
