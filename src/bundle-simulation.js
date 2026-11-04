import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { buySimulationBudget } from './buy-simulation.js';
import { DEVNET_GENESIS } from './network.js';
import { frozenJson, raw, requireSafe } from './security.js';

const SIMULATOR = 'http://127.0.0.1:8899/';
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function request(method, params) {
  const response = await fetch(SIMULATOR, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  requireSafe(response.ok && response.body, 'BUNDLE_SIMULATOR_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireSafe(size <= MAX_RESPONSE_BYTES, 'BUNDLE_SIMULATOR_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireSafe(payload?.jsonrpc === '2.0' && payload.id === 1 &&
    !payload.error && Object.hasOwn(payload, 'result'), 'BUNDLE_SIMULATOR_REJECTED');
  return payload.result;
}

function tokenBalance(rows, accountIndex, owner, mint, allowAbsent = false) {
  requireSafe(Array.isArray(rows), 'BUNDLE_TOKEN_BALANCE_EVIDENCE_MISSING');
  const matches = rows.filter(row => row?.accountIndex === accountIndex);
  if (!matches.length && allowAbsent) return 0n;
  requireSafe(matches.length === 1 && matches[0].owner === owner && matches[0].mint === mint,
    'BUNDLE_TOKEN_BALANCE_IDENTITY_MISMATCH');
  return raw(matches[0].uiTokenAmount?.amount, { positive: false });
}

export async function simulateLaunchBundle(bundle, signedWires, rpc = request) {
  const { review } = bundle;
  requireSafe(Date.now() < review.expiresAt && signedWires.length === review.transactions.length,
    'BUNDLE_REVIEW_EXPIRED_OR_INCOMPLETE');
  requireSafe(await rpc('getGenesisHash', []) === DEVNET_GENESIS, 'BUNDLE_SIMULATOR_NOT_DEVNET');
  const result = await rpc('simulateBundle', [{ encodedTransactions: signedWires }, {
    transactionEncoding: 'base64', simulationBank: { commitment: { commitment: 'confirmed' } },
    preExecutionAccountsConfigs: signedWires.map(() => null),
    postExecutionAccountsConfigs: signedWires.map(() => null),
    skipSigVerify: false, replaceRecentBlockhash: false,
  }]);
  const value = result?.value;
  requireSafe(value?.summary === 'succeeded' && Array.isArray(value.transactionResults) &&
    value.transactionResults.length === review.transactions.length &&
    Number.isSafeInteger(result.context?.slot) && result.context.slot >= 0, 'BUNDLE_SIMULATION_FAILED');

  const transactions = review.transactions.map((step, index) => {
    const simulation = value.transactionResults[index];
    const budget = buySimulationBudget({ tradeBudgetLamports: step.spendLamports ?? '0',
      maxDebitLamports: step.maxDebitLamports }, step.feeLamports, { value: simulation });
    const receipt = { action: step.action, payerAddress: step.payerAddress, ...budget };
    if (step.action === 'buy') {
      const tx = getTransactionDecoder().decode(Buffer.from(signedWires[index], 'base64'));
      const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const accountIndex = staticAccounts.indexOf(step.destinationTokenAccount);
      requireSafe(accountIndex >= 0, 'BUNDLE_DESTINATION_ACCOUNT_MISSING');
      const before = tokenBalance(simulation.preTokenBalances, accountIndex, step.payerAddress, review.mintAddress, true);
      const after = tokenBalance(simulation.postTokenBalances, accountIndex, step.payerAddress, review.mintAddress);
      const credit = after - before;
      requireSafe(credit >= raw(step.minimumOutputRaw), 'BUNDLE_OUTPUT_BELOW_MINIMUM');
      receipt.outputCreditedRaw = String(credit);
    }
    return receipt;
  });
  requireSafe(Date.now() < review.expiresAt, 'BUNDLE_REVIEW_EXPIRED');
  return frozenJson({ simulated: true, digest: bundle.digest, slot: result.context.slot, transactions, broadcast: false });
}
