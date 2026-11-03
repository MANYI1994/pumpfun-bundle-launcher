import { httpsField, tokenMetadata } from './create-token.js';
import { LIMITS } from './plans.js';
import { digest, exactKeys, frozenJson, raw, requireSafe, validAddress } from './security.js';

const MAX_TRANSACTIONS = 5;

export function planLaunchBundle(input) {
  exactKeys(input, ['creatorAddress', 'mintAddress', 'metadata', 'metadataUri',
    'creationMaxDebitLamports', 'buyers']);
  const creatorAddress = validAddress(input.creatorAddress);
  const mintAddress = validAddress(input.mintAddress);
  requireSafe(creatorAddress !== mintAddress, 'MINT_AND_CREATOR_MUST_DIFFER');
  const metadata = tokenMetadata(input.metadata);
  const metadataUri = httpsField(input.metadataUri);
  const creationCap = raw(input.creationMaxDebitLamports);
  requireSafe(creationCap <= LIMITS.maxSpendLamports, 'CREATION_DEBIT_LIMIT_EXCEEDED');
  requireSafe(Array.isArray(input.buyers) && input.buyers.length >= 1 &&
    input.buyers.length < MAX_TRANSACTIONS, 'BUNDLE_BUYER_LIMIT');

  const seen = new Set([creatorAddress, mintAddress]);
  let total = creationCap;
  const buys = input.buyers.map(buyer => {
    exactKeys(buyer, ['address', 'spendLamports', 'maxDebitLamports', 'slippageBps']);
    const address = validAddress(buyer.address);
    requireSafe(!seen.has(address), 'DUPLICATE_BUNDLE_SIGNER');
    seen.add(address);
    const spend = raw(buyer.spendLamports);
    const cap = raw(buyer.maxDebitLamports);
    requireSafe(spend < cap && cap <= LIMITS.maxSpendLamports, 'INVALID_BUNDLE_BUY_BUDGET');
    const { slippageBps } = buyer;
    requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 &&
      slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
    total += cap;
    return { action: 'buy', payerAddress: address, requiredSigners: [address],
      spendLamports: String(spend), maxDebitLamports: String(cap), slippageBps,
      minimumOutputRaw: null };
  });

  const plan = {
    version: 1, action: 'launch-bundle', cluster: 'devnet', mode: 'rehearsal-plan',
    mintAddress, creatorAddress, metadata, metadataUri,
    transactionCount: 1 + buys.length, maxTransactions: MAX_TRANSACTIONS,
    totalDebitCapsLamports: String(total),
    steps: [{ action: 'create', payerAddress: creatorAddress,
      requiredSigners: [creatorAddress, mintAddress], maxDebitLamports: String(creationCap) }, ...buys],
    tipLamports: '0', broadcast: false,
  };
  return frozenJson({ plan, digest: digest(plan) });
}
