import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSwapTokenChanges } from '../src/pumpswap-simulation.js';

test('PumpSwap simulation checks the exact source and destination token balance changes', () => {
  const plan = {
    side: 'sell', owner: 'wallet', sourceMint: 'base', destinationMint: 'wsol',
    sourceAccountIndex: 3, destinationAccountIndex: 4,
    inputAmountRaw: '100', minimumOutputRaw: '40', inputUnit: 'token-raw', outputUnit: 'lamports',
  };
  const row = (accountIndex, mint, amount) => ({ accountIndex, mint, owner: 'wallet', uiTokenAmount: { amount } });
  const value = {
    preTokenBalances: [row(3, 'base', '200'), row(4, 'wsol', '0')],
    postTokenBalances: [row(3, 'base', '100'), row(4, 'wsol', '41')],
  };
  assert.equal(checkSwapTokenChanges(plan, { value }).outputCreditedRaw, '41');
  value.postTokenBalances[1].uiTokenAmount.amount = '39';
  assert.throws(() => checkSwapTokenChanges(plan, { value }), /SWAP_OUTPUT_BELOW_MINIMUM/);
  value.postTokenBalances[1] = row(5, 'wsol', '41');
  assert.throws(() => checkSwapTokenChanges(plan, { value }), /SWAP_TOKEN_BALANCE_IDENTITY_MISMATCH/);
});
