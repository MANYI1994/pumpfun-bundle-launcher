import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddressEncoder } from '@solana/kit';
import { inspectCleanupAccount } from '../src/cleanup.js';
import { TOKEN } from '../src/transactions.js';

const owner = 'SysvarRent111111111111111111111111111111111';
const encode = address => Buffer.from(getAddressEncoder().encode(address));
function fixture() {
  const data = Buffer.alloc(165);
  encode(owner).copy(data, 32);
  data[108] = 1;
  return { data, account: () => ({
    executable: false, owner: TOKEN, lamports: 2039280, data: [data.toString('base64'), 'base64'],
  }) };
}
test('cleanup rejects funded ordinary token accounts and unrelated close authorities', () => {
  const { data, account } = fixture();
  assert.equal(inspectCleanupAccount(account(), owner).cleanupKind, 'close-empty-account');
  data.writeBigUInt64LE(1n, 64);
  assert.throws(() => inspectCleanupAccount(account(), owner), /TOKEN_ACCOUNT_NOT_EMPTY/);
  data.writeBigUInt64LE(0n, 64);
  data.writeUInt32LE(1, 129);
  assert.throws(() => inspectCleanupAccount(account(), owner), /CLEANUP_CLOSE_AUTHORITY_MISMATCH/);
});
test('cleanup recognizes the classic wrapped SOL account and includes its rent', () => {
  const { data, account } = fixture();
  encode('So11111111111111111111111111111111111111112').copy(data, 0);
  data.writeUInt32LE(1, 109);
  data.writeBigUInt64LE(2000000n, 113);
  data.writeBigUInt64LE(39280n, 64);
  const review = inspectCleanupAccount(account(), owner);
  assert.equal(review.cleanupKind, 'unwrap-sol');
  assert.equal(review.recoveredLamports, '2039280');
});
