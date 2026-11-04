import { AccountRole, compileTransaction, getAddressEncoder } from '@solana/kit';
import { Rpc, assertDevnetContext } from './network.js';
import { exactKeys, frozenJson, requireSafe, validAddress } from './security.js';
import { TOKEN, bounded, message } from './transactions.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';
const encoder = getAddressEncoder();
const bytes = address => Buffer.from(encoder.encode(address));

export function inspectCleanupAccount(account, owner) {
  requireSafe(account?.executable === false && [TOKEN, TOKEN_2022].includes(account.owner) &&
    Array.isArray(account.data) && account.data[1] === 'base64' && typeof account.data[0] === 'string',
  'INVALID_CLEANUP_ACCOUNT');
  const data = Buffer.from(account.data[0], 'base64');
  const immutableOwnerOnly = account.owner === TOKEN_2022 && data.length === 170 &&
    data.subarray(165).equals(Buffer.from([2, 7, 0, 0, 0]));
  requireSafe(data.toString('base64') === account.data[0] && (data.length === 165 || immutableOwnerOnly),
    'UNSUPPORTED_TOKEN_ACCOUNT_EXTENSIONS');
  requireSafe(data[108] === 1 && data.subarray(32, 64).equals(bytes(owner)), 'CLEANUP_OWNER_OR_STATE_MISMATCH');
  const closeAuthority = data.readUInt32LE(129);
  requireSafe(closeAuthority === 0 || (closeAuthority === 1 && data.subarray(133, 165).equals(bytes(owner))),
    'CLEANUP_CLOSE_AUTHORITY_MISMATCH');
  const native = data.readUInt32LE(109);
  const wrapped = account.owner === TOKEN && native === 1 && data.subarray(0, 32).equals(bytes(WSOL));
  requireSafe(wrapped || (native === 0 && data.readBigUInt64LE(64) === 0n), 'TOKEN_ACCOUNT_NOT_EMPTY');
  requireSafe(Number.isSafeInteger(account.lamports) && account.lamports > 0, 'INVALID_ACCOUNT_LAMPORTS');
  if (wrapped) {
    requireSafe(BigInt(account.lamports) >= data.readBigUInt64LE(113) + data.readBigUInt64LE(64),
      'INVALID_WRAPPED_SOL_BALANCE');
  }
  return { tokenProgram: account.owner, cleanupKind: wrapped ? 'unwrap-sol' : 'close-empty-account',
    recoveredLamports: String(account.lamports) };
}

export async function compileCleanup(input, rpc = new Rpc()) {
  exactKeys(input, ['owner', 'tokenAccount']);
  const owner = validAddress(input.owner);
  const tokenAccount = validAddress(input.tokenAccount);
  requireSafe(owner !== tokenAccount, 'CLEANUP_SOURCE_IS_WALLET');
  const [result, context] = await Promise.all([
    rpc.read('getAccountInfo', [tokenAccount, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc.getBlockhashContext(),
  ]);
  const details = inspectCleanupAccount(result?.value, owner);
  const lifetime = assertDevnetContext(context);
  const tx = bounded(compileTransaction(message(owner, lifetime, [{
    programAddress: details.tokenProgram,
    accounts: [
      { address: tokenAccount, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.of(9),
  }])));
  const candidate = frozenJson({ action: 'cleanup', owner, payerAddress: owner,
    tokenAccount, proceedsAddress: owner, ...details, expiresAt: context.expiresAt });
  return { candidate, tx, context };
}
