import { getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { frozenJson, raw, requireSafe, validAddress } from './security.js';
import { transactionFingerprint } from './transactions.js';

function indexedTokenBalances(rows, accountCount) {
  const balances = new Map();
  for (const row of rows) {
    const index = row?.accountIndex;
    requireSafe(Number.isSafeInteger(index) && index >= 0 && index < accountCount &&
      !balances.has(index), 'INVALID_FINALIZED_TOKEN_BALANCES');
    balances.set(index, { mint: validAddress(row.mint), owner: row.owner === undefined ? null : validAddress(row.owner),
      amount: raw(row.uiTokenAmount?.amount, { positive: false }) });
  }
  return balances;
}

function walletTokenChanges(meta, accounts, wallet) {
  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return null;
  const before = indexedTokenBalances(meta.preTokenBalances, accounts.length);
  const after = indexedTokenBalances(meta.postTokenBalances, accounts.length);
  const changes = [];
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    const pre = before.get(index);
    const post = after.get(index);
    if (pre?.owner !== wallet && post?.owner !== wallet) continue;
    requireSafe(!pre || !post || (pre.mint === post.mint &&
      (!pre.owner || !post.owner || pre.owner === post.owner)), 'FINALIZED_TOKEN_IDENTITY_CHANGED');
    const from = pre?.amount ?? 0n;
    const to = post?.amount ?? 0n;
    if (from !== to) changes.push({
      tokenAccount: accounts[index], mint: (pre ?? post).mint,
      beforeRaw: String(from), afterRaw: String(to), changeRaw: String(to - from),
    });
  }
  return changes;
}

export async function inspectFinalizedBalances(rpc, intent) {
  const result = await rpc.read('getTransaction', [intent.signature, {
    encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0,
  }]);
  requireSafe(result && Number.isSafeInteger(result.slot) && result.slot >= 0 &&
    result.meta?.err === null && Array.isArray(result.transaction) &&
    result.transaction[1] === 'base64' && typeof result.transaction[0] === 'string' &&
    result.transaction[0].length <= 1644, 'FINALIZED_TRANSACTION_UNAVAILABLE');
  const wire = Buffer.from(result.transaction[0], 'base64');
  requireSafe(wire.length <= 1232 && wire.toString('base64') === result.transaction[0], 'INVALID_FINALIZED_WIRE');
  const tx = getTransactionDecoder().decode(wire);
  requireSafe(getSignatureFromTransaction(tx) === intent.signature &&
    transactionFingerprint(tx) === intent.fingerprint, 'FINALIZED_TRANSACTION_MISMATCH');
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  requireSafe(compiled.version === 'legacy' && compiled.staticAccounts[0] === intent.payerAddress,
    'FINALIZED_PAYER_MISMATCH');
  const { preBalances, postBalances, fee } = result.meta;
  requireSafe(Array.isArray(preBalances) && Array.isArray(postBalances) &&
    preBalances.length === compiled.staticAccounts.length && postBalances.length === compiled.staticAccounts.length &&
    [preBalances[0], postBalances[0], fee].every(value => Number.isSafeInteger(value) && value >= 0),
  'FINALIZED_SOL_BALANCES_UNAVAILABLE');
  return frozenJson({
    slot: result.slot, payerAddress: intent.payerAddress, feeLamports: String(fee),
    solBeforeLamports: String(preBalances[0]), solAfterLamports: String(postBalances[0]),
    solChangeLamports: String(BigInt(postBalances[0]) - BigInt(preBalances[0])),
    tokenChanges: walletTokenChanges(result.meta, compiled.staticAccounts, intent.payerAddress),
  });
}
