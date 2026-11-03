import {
  AccountRole, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compileTransaction, signTransaction, assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction, getAddressEncoder, getProgramDerivedAddress,
} from '@solana/kit';
import { raw, requireSafe, validAddress, digest } from './security.js';
import { validateEnvelope, LIMITS } from './plans.js';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const bytes = a => getAddressEncoder().encode(validAddress(a));
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (address, writable = false, signer = false) => ({ address: validAddress(address), role: signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (writable ? AccountRole.WRITABLE : AccountRole.READONLY) });
async function pda(programAddress, seeds) { return (await getProgramDerivedAddress({ programAddress, seeds }))[0]; }
export async function tokenAccount(owner, mint) { return pda(ASSOCIATED, [bytes(owner), bytes(TOKEN), bytes(mint)]); }
export function transferInstruction(from, to, lamports) {
  requireSafe(from !== to, 'SELF_TRANSFER');
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2);
  return { programAddress: SYSTEM, accounts: [meta(from, true, true), meta(to, true)], data: Buffer.concat([tag, u64(raw(String(lamports)))]) };
}
function message(payer, lifetime, instructions) {
  validAddress(payer); validAddress(lifetime.blockhash);
  requireSafe(typeof lifetime.lastValidBlockHeight === 'bigint' && lifetime.lastValidBlockHeight > 0n, 'INVALID_BLOCKHASH_LIFETIME');
  let m = createTransactionMessage({ version: 'legacy' });
  m = setTransactionMessageFeePayer(payer, m);
  m = setTransactionMessageLifetimeUsingBlockhash(lifetime, m);
  return appendTransactionMessageInstructions(instructions, m);
}
function bounded(tx) {
  const wire = getBase64EncodedWireTransaction(tx);
  requireSafe(Buffer.from(wire, 'base64').length <= 1232, 'TRANSACTION_TOO_LARGE');
  return tx;
}
export function compileFunding(envelope, confirmation, lifetime, now = Date.now()) {
  const plan = validateEnvelope(envelope, confirmation, now);
  requireSafe(plan.action === 'fund' && plan.tipLamports === '0', 'UNSUPPORTED_FUNDING_PLAN');
  const instructions = plan.wallets.map(w => transferInstruction(plan.payerAddress, w.address, w.lamports));
  return bounded(compileTransaction(message(plan.payerAddress, lifetime, instructions)));
}

// Offline candidate builder only. No broadcast path accepts these messages yet.
// All required token-owner signatures are retained; no consolidation or random payer.
export async function compileCurveSells(envelope, confirmation, lifetime, state, now = Date.now()) {
  const plan = validateEnvelope(envelope, confirmation, now);
  requireSafe(plan.action === 'sell' && plan.tipLamports === '0', 'UNSUPPORTED_SELL_PLAN');
  requireSafe(state && state.owner === PUMP && state.mint === plan.mint && state.complete === false, 'CURVE_OR_MINT_MISMATCH');
  validAddress(state.creator); validAddress(state.feeRecipient);
  requireSafe(raw(state.totalSupplyRaw) >= raw(plan.totalAmountRaw), 'SALE_EXCEEDS_SUPPLY');
  const curve = await pda(PUMP, [Buffer.from('bonding-curve'), bytes(plan.mint)]);
  requireSafe(state.curve === curve, 'CURVE_ADDRESS_MISMATCH');
  const global = await pda(PUMP, [Buffer.from('global')]);
  const creatorVault = await pda(PUMP, [Buffer.from('creator-vault'), bytes(state.creator)]);
  const event = await pda(PUMP, [Buffer.from('__event_authority')]);
  const curveAta = await tokenAccount(curve, plan.mint);
  const feeProgram = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
  const feeConfig = await pda(feeProgram, [Buffer.from('fee_config'), bytes(PUMP)]);
  const transactions = [];
  for (const w of plan.wallets) {
    const ata = await tokenAccount(w.address, plan.mint);
    const instruction = { programAddress: PUMP, accounts: [meta(global), meta(state.feeRecipient, true), meta(plan.mint), meta(curve, true), meta(curveAta, true), meta(ata, true), meta(w.address, true, true), meta(SYSTEM), meta(creatorVault, true), meta(TOKEN), meta(event), meta(PUMP), meta(feeConfig), meta(feeProgram)], data: Buffer.concat([SELL_DISCRIMINATOR, u64(raw(w.amountRaw)), u64(raw(w.minimumOutputLamports))]) };
    transactions.push(bounded(compileTransaction(message(w.address, lifetime, [instruction]))));
  }
  requireSafe(transactions.length <= LIMITS.maxWallets, 'BUNDLE_TOO_LARGE');
  return transactions;
}
export async function signComplete(transaction, signers) {
  const expected = Object.keys(transaction.signatures).sort();
  requireSafe(Array.isArray(signers) && new Set(signers.map(s => s.address)).size === signers.length && signers.map(s => s.address).sort().join(',') === expected.join(','), 'SIGNER_SET_MISMATCH');
  const signed = await signTransaction(signers.map(s => s.keyPair), transaction);
  assertIsFullySignedTransaction(signed);
  return bounded(signed);
}
export function transactionFingerprint(transaction) { return digest({ message: Buffer.from(transaction.messageBytes).toString('base64'), signers: Object.keys(transaction.signatures) }); }
