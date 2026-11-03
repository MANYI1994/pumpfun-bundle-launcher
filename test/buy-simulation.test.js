import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateVerifiedBuy } from '../src/buy-simulation.js';

const review = { details: {
  plan: { action: 'buy', tradeBudgetLamports: '1000000', maxDebitLamports: '1500000' },
  budget: { feeLamports: '5000' },
  expiresAt: Date.now() + 60000,
} };
const verified = { productionVerified: true, transactions: [{ wireBase64: 'AA==', fingerprint: 'fixture' }] };

function rpcWith(value) {
  return { async read(method, params) {
    assert.equal(method, 'simulateTransaction');
    assert.equal(params[0], 'AA==');
    assert.equal(params[1].sigVerify, true);
    assert.equal(params[1].replaceRecentBlockhash, false);
    return { value };
  } };
}

test('buy simulation counts rent and fee in total debit', async () => {
  const result = await simulateVerifiedBuy(review, verified, rpcWith({
    err: null, fee: 5000, preBalances: [20000000], postBalances: [18700000],
  }));
  assert.equal(result.conservativeDebitLamports, '1305000');
  assert.equal(result.broadcast, false);
});

test('buy simulation rejects excessive debit and missing payer evidence', async () => {
  await assert.rejects(simulateVerifiedBuy(review, verified, rpcWith({
    err: null, fee: 5000, preBalances: [20000000], postBalances: [18400000],
  })), /SIMULATED_DEBIT_OUTSIDE_APPROVAL/);
  await assert.rejects(simulateVerifiedBuy(review, verified, rpcWith({
    err: null, fee: 5000,
  })), /SIMULATION_BALANCE_EVIDENCE_UNAVAILABLE/);
});
