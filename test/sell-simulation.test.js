import test from 'node:test';
import assert from 'node:assert/strict';
import { sellSimulationBudget } from '../src/sell-simulation.js';

const plan = { minimumOutputLamports: '1000000' };
const evidence = post => ({ value: {
  err: null, fee: 5000, preBalances: [20000000], postBalances: [post],
} });

test('sell simulation requires minimum proceeds after a conservative fee deduction', () => {
  const budget = sellSimulationBudget(plan, '5000', evidence(21005000));
  assert.equal(budget.conservativeNetProceedsLamports, '1000000');
  assert.throws(() => sellSimulationBudget(plan, '5000', evidence(21004999)), /SIMULATED_SELL_PROCEEDS_TOO_LOW/);
  assert.throws(() => sellSimulationBudget(plan, '6000', evidence(21005000)), /SIMULATED_FEE_CHANGED/);
});
