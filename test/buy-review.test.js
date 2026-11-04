import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBuy } from '../src/buy-review.js';
import { PUMP } from '../src/transactions.js';

const input = {
  owner: 'So11111111111111111111111111111111111111112',
  mint: 'SysvarRent111111111111111111111111111111111',
  spendLamports: '1000000',
  slippageBps: 100,
};
function fixture() {
  const curve = Buffer.alloc(115);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve);
  curve.writeBigUInt64LE(1000000000000n, 8);
  curve.writeBigUInt64LE(1000000000n, 16);
  curve.writeBigUInt64LE(800000000000n, 24);
  curve.writeBigUInt64LE(1000000000000n, 40);
  curve[49] = 1;
  const fee = Buffer.alloc(149);
  Buffer.from([143, 52, 146, 187, 219, 123, 76, 155]).copy(fee);
  fee.writeUInt32LE(2, 65);
  fee.writeBigUInt64LE(200n, 93);
  fee.writeBigUInt64LE(900000000n, 109);
  fee.writeBigUInt64LE(100n, 133);
  fee.writeBigUInt64LE(50n, 141);
  return { curve, fee, rpc: {
    account: async (_address, owner) => owner === PUMP ? curve : fee,
    read: async () => ({ value: 20000000 }),
  } };
}
test('buy review applies the matching fee tier and rounds output down', async () => {
  const { rpc } = fixture();
  const { review } = await reviewBuy(input, rpc);
  assert.equal(review.protocolFeeBps, '100');
  assert.equal(review.creatorFeeBps, '50');
  assert.equal(review.expectedTokenAmountRaw, '984249298');
  assert.equal(review.minimumTokenAmountRaw, '974406805');
  assert.equal(review.broadcast, false);
});
test('buy review stops at completed curves and unsupported quote mints', async () => {
  const { rpc, curve } = fixture();
  curve[48] = 1;
  await assert.rejects(reviewBuy(input, rpc), /CURVE_COMPLETE/);
  curve[48] = 0;
  curve[83] = 1;
  await assert.rejects(reviewBuy(input, rpc), /UNSUPPORTED_CURVE_MODE/);
});
