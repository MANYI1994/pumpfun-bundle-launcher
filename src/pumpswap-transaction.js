import {
  AccountRole, compileTransaction, getAddressEncoder, getBase58Decoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getProgramDerivedAddress,
} from '@solana/kit';
import { PUMP_SWAP } from './migration.js';
import { Rpc, assertDevnetContext } from './network.js';
import { reviewPumpSwap } from './pumpswap-review.js';
import { digest, frozenJson, requireSafe } from './security.js';
import { ASSOCIATED, SYSTEM, TOKEN, bounded, message, transactionFingerprint } from './transactions.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const GLOBAL_TAG = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]);
const BUYBACK_OFFSET = 643;
const encoder = getAddressEncoder();
const bytes = address => Buffer.from(encoder.encode(address));

async function pda(programAddress, seeds) {
  return (await getProgramDerivedAddress({ programAddress, seeds }))[0];
}

async function existingAta(rpc, owner, mint, tokenProgram) {
  const address = await pda(ASSOCIATED, [bytes(owner), bytes(tokenProgram), bytes(mint)]);
  const data = await rpc.account(address, tokenProgram);
  requireSafe(data.length >= 165 && data[108] === 1 &&
    data.subarray(0, 32).equals(bytes(mint)) && data.subarray(32, 64).equals(bytes(owner)),
  'INVALID_SWAP_TOKEN_ACCOUNT');
  if (mint === WSOL) requireSafe(data.readUInt32LE(109) === 1, 'INVALID_WRAPPED_SOL_ACCOUNT');
  return { address, amount: data.readBigUInt64LE(64) };
}

export async function compilePumpSwapCandidate(input, rpc = new Rpc()) {
  const { review } = await reviewPumpSwap(input, rpc);
  const { owner, mint, baseTokenProgram } = review;
  const [global, volume, feeConfig, eventAuthority] = await Promise.all([
    pda(PUMP_SWAP, [Buffer.from('global_config')]),
    pda(PUMP_SWAP, [Buffer.from('user_volume_accumulator'), bytes(owner)]),
    pda(FEES, [Buffer.from('fee_config'), bytes(PUMP_SWAP)]),
    pda(PUMP_SWAP, [Buffer.from('__event_authority')]),
  ]);
  const [config, baseUser, quoteUser, context] = await Promise.all([
    rpc.account(global, PUMP_SWAP),
    existingAta(rpc, owner, mint, baseTokenProgram),
    existingAta(rpc, owner, WSOL, TOKEN),
    rpc.getBlockhashContext(),
  ]);
  requireSafe(config.length >= BUYBACK_OFFSET + 256 &&
    config.subarray(0, 8).equals(GLOBAL_TAG) && config[56] === 0, 'UNSUPPORTED_SWAP_GLOBAL_CONFIG');
  const recipient = config.subarray(BUYBACK_OFFSET, BUYBACK_OFFSET + 32);
  requireSafe(recipient.some(byte => byte !== 0), 'MISSING_BUYBACK_RECIPIENT');
  const { address: buyback } = await existingAta(rpc, getBase58Decoder().decode(recipient), WSOL, TOKEN);
  const isBuy = review.side === 'buy';
  const amount = BigInt(review.inputAmountRaw);
  requireSafe((isBuy ? quoteUser.amount : baseUser.amount) >= amount, 'INSUFFICIENT_SWAP_INPUT_BALANCE');

  const data = Buffer.alloc(24);
  Buffer.from(isBuy ? [194, 171, 28, 70, 104, 77, 91, 47] : [93, 246, 130, 60, 231, 233, 64, 178]).copy(data);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(BigInt(review.minimumOutputRaw), 16);
  const { READONLY: R, WRITABLE: W, WRITABLE_SIGNER: S } = AccountRole;
  const instruction = {
    programAddress: PUMP_SWAP,
    accounts: [
      [review.pool, W], [owner, S], [global, R], [mint, R], [WSOL, R],
      [baseUser.address, W], [quoteUser.address, W], [review.baseVault, W], [review.quoteVault, W],
      [baseTokenProgram, R], [TOKEN, R], [SYSTEM, R], [volume, W], [feeConfig, R],
      [buyback, W], [eventAuthority, R], [PUMP_SWAP, R],
    ].map(([address, role]) => ({ address, role })),
    data,
  };
  const lifetime = assertDevnetContext(context);
  requireSafe(Date.now() < review.expiresAt, 'SWAP_REVIEW_EXPIRED');
  const tx = bounded(compileTransaction(message(owner, lifetime, [instruction])));
  const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const candidate = {
    ...review, instruction: isBuy ? 'buy_exact_quote_in_v2' : 'sell_v2',
    sourceTokenAccount: isBuy ? quoteUser.address : baseUser.address,
    sourceAccountIndex: staticAccounts.indexOf(isBuy ? quoteUser.address : baseUser.address),
    destinationAccountIndex: staticAccounts.indexOf(isBuy ? baseUser.address : quoteUser.address),
    sourceMint: isBuy ? WSOL : mint,
    destinationMint: isBuy ? mint : WSOL,
    destinationTokenAccount: isBuy ? baseUser.address : quoteUser.address,
    buybackFeeTokenAccount: buyback, blockhash: lifetime.blockhash,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    requiredSigners: Object.keys(tx.signatures), fingerprint: transactionFingerprint(tx),
    unsignedWireBase64: getBase64EncodedWireTransaction(tx), signingAllowed: false,
  };
  return { candidate: frozenJson(candidate), tx, context };
}

export async function buildPumpSwapTransaction(input, rpc = new Rpc()) {
  const { candidate } = await compilePumpSwapCandidate(input, rpc);
  return frozenJson({ review: candidate, digest: digest(candidate) });
}
