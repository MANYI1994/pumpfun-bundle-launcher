import {
  AccountRole, compileTransaction, getAddressEncoder, getBase58Decoder,
  getBase64EncodedWireTransaction, getProgramDerivedAddress,
} from '@solana/kit';
import { reviewBuy } from './buy-review.js';
import { Rpc, assertDevnetContext } from './network.js';
import { digest, frozenJson, requireSafe } from './security.js';
import { ASSOCIATED, TOKEN, PUMP, SYSTEM, bounded, message, transactionFingerprint } from './transactions.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const GLOBAL_TAG = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);
const BUYBACK_OFFSET = 741;
const encoder = getAddressEncoder();
const bytes = address => encoder.encode(address);

async function pda(programAddress, seeds) {
  return (await getProgramDerivedAddress({ programAddress, seeds }))[0];
}

function ata(owner, program, mint) {
  return pda(ASSOCIATED, [bytes(owner), bytes(program), bytes(mint)]);
}

export async function buildBuyTransaction(input, rpc = new Rpc()) {
  const { review } = await reviewBuy(input, rpc);
  const { owner, mint, curveAddress } = review;
  const [global, feeConfig, volume, eventAuthority] = await Promise.all([
    pda(PUMP, [Buffer.from('global')]),
    pda(FEES, [Buffer.from('fee_config'), bytes(PUMP)]),
    pda(PUMP, [Buffer.from('user_volume_accumulator'), bytes(owner)]),
    pda(PUMP, [Buffer.from('__event_authority')]),
  ]);
  const [config, mintAccount, context] = await Promise.all([
    rpc.account(global, PUMP),
    rpc.read('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc.getBlockhashContext(),
  ]);
  requireSafe(config.length >= BUYBACK_OFFSET + 256 &&
    config.subarray(0, 8).equals(GLOBAL_TAG), 'UNSUPPORTED_GLOBAL_LAYOUT');
  const recipientBytes = config.subarray(BUYBACK_OFFSET, BUYBACK_OFFSET + 32);
  requireSafe(recipientBytes.some(byte => byte !== 0), 'MISSING_BUYBACK_RECIPIENT');
  const buyback = getBase58Decoder().decode(recipientBytes);

  const account = mintAccount?.value;
  requireSafe(account?.executable === false && [TOKEN, TOKEN_2022].includes(account.owner) &&
    account.data?.[1] === 'base64' && typeof account.data[0] === 'string', 'INVALID_BASE_MINT');
  const mintData = Buffer.from(account.data[0], 'base64');
  requireSafe(mintData.length >= 82 && mintData[45] === 1, 'INVALID_BASE_MINT');
  const program = account.owner;
  const [baseCurve, quoteCurve, baseUser, quoteUser] = await Promise.all([
    ata(curveAddress, program, mint), ata(curveAddress, TOKEN, WSOL),
    ata(owner, program, mint), ata(owner, TOKEN, WSOL),
  ]);

  const { READONLY: R, WRITABLE: W, WRITABLE_SIGNER: S } = AccountRole;
  const metas = pairs => pairs.map(([address, role]) => ({ address, role }));
  const createAta = {
    programAddress: ASSOCIATED,
    accounts: metas([[owner, S], [baseUser, W], [owner, R], [mint, R], [SYSTEM, R], [program, R]]),
    data: Uint8Array.of(1),
  };
  const data = Buffer.alloc(25);
  Buffer.from([225, 247, 80, 30, 213, 179, 132, 136]).copy(data);
  data.writeBigUInt64LE(BigInt(review.tradeBudgetLamports), 8);
  data.writeBigUInt64LE(BigInt(review.minimumTokenAmountRaw), 16);
  const buy = {
    programAddress: PUMP,
    accounts: metas([
      [global, R], [mint, R], [WSOL, R], [program, R], [TOKEN, R],
      [curveAddress, W], [baseCurve, W], [quoteCurve, W], [owner, S],
      [baseUser, W], [quoteUser, W], [volume, W], [feeConfig, R],
      [buyback, W], [SYSTEM, R], [eventAuthority, R], [PUMP, R],
    ]),
    data,
  };
  const lifetime = assertDevnetContext(context);
  requireSafe(Date.now() < review.expiresAt, 'BUY_REVIEW_EXPIRED');
  const tx = bounded(compileTransaction(message(owner, lifetime, [createAta, buy])));
  const candidate = {
    ...review, instruction: 'buy_exact_quote_in_v3', baseTokenProgram: program,
    destinationTokenAccount: baseUser, buybackFeeRecipient: buyback,
    blockhash: lifetime.blockhash, lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    requiredSigners: Object.keys(tx.signatures), fingerprint: transactionFingerprint(tx),
    unsignedWireBase64: getBase64EncodedWireTransaction(tx), signingAllowed: false,
  };
  return frozenJson({ review: candidate, digest: digest(candidate) });
}
