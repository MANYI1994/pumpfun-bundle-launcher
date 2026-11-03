import { getTransactionDecoder } from '@solana/kit';
import { Rpc } from './network.js';
import { LIMITS } from './plans.js';
import { raw, requireSafe } from './security.js';
import { verifyCreationSignatures } from './create-verification.js';
import { buySimulationBudget } from './buy-simulation.js';

export async function simulateCreation({ envelope, confirmation, signedWires, maxDebitLamports }, rpc = new Rpc()) {
  const cap = raw(maxDebitLamports);
  requireSafe(cap <= LIMITS.maxSpendLamports, 'TOTAL_DEBIT_LIMIT_EXCEEDED');
  const verified = await verifyCreationSignatures(envelope, confirmation, signedWires);
  const validity = await rpc.read('isBlockhashValid', [envelope.review.blockhash, { commitment: 'confirmed' }]);
  requireSafe(validity?.value === true, 'CREATION_BLOCKHASH_EXPIRED');
  const transaction = getTransactionDecoder().decode(Buffer.from(verified.signedWireBase64, 'base64'));
  const message = Buffer.from(transaction.messageBytes).toString('base64');
  const fee = await rpc.read('getFeeForMessage', [message, { commitment: 'confirmed' }]);
  requireSafe(Number.isSafeInteger(fee?.value) && fee.value > 0, 'CREATION_FEE_UNAVAILABLE');
  const result = await rpc.read('simulateTransaction', [verified.signedWireBase64, {
    encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false,
  }]);
  const budget = buySimulationBudget({ tradeBudgetLamports: '0', maxDebitLamports: String(cap) }, String(fee.value), result);
  const { signedWireBase64, ...receipt } = verified;
  return { ...receipt, simulated: true, maxDebitLamports: String(cap), budget };
}
