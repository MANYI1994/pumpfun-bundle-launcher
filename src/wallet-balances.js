import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { ASSOCIATED, TOKEN } from './transactions.js';
import { requireSafe, validAddress } from './security.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const encoder = getAddressEncoder();
const bytes = address => Buffer.from(encoder.encode(address));

export async function balances(rpc, owner, mint) {
  validAddress(owner);
  if (mint !== '') validAddress(mint);
  const sol = await rpc.read('getBalance', [owner]);
  requireSafe(Number.isSafeInteger(sol?.value) && sol.value >= 0, 'INVALID_SOL_BALANCE');
  const accounts = [];
  if (mint) {
    for (const program of [TOKEN, TOKEN_2022]) {
      const [address] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED, seeds: [bytes(owner), bytes(program), bytes(mint)],
      });
      const result = await rpc.read('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
      if (result?.value === null) continue;
      const account = result?.value;
      requireSafe(account?.owner === program && account.executable === false &&
        Array.isArray(account.data) && account.data[1] === 'base64' &&
        typeof account.data[0] === 'string', 'INVALID_TOKEN_ACCOUNT');
      const data = Buffer.from(account.data[0], 'base64');
      requireSafe(data.length >= 165 && data.subarray(0, 32).equals(bytes(mint)) &&
        data.subarray(32, 64).equals(bytes(owner)) && [1, 2].includes(data[108]), 'INVALID_TOKEN_ACCOUNT');
      accounts.push({ address, program, rawAmount: String(data.readBigUInt64LE(64)), frozen: data[108] === 2 });
    }
  }
  return { owner, mint, lamports: String(sol.value), associatedTokenAccounts: accounts, observedAt: Date.now() };
}

