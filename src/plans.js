import { randomUUID } from 'node:crypto';
import { raw, percentage, validAddress, requireSafe, digest, frozenJson, exactKeys, equalDigest } from './security.js';

export const LIMITS = Object.freeze({ maxWallets: 5, maxSlippageBps: 300, maxTipLamports: 1000000n, maxSpendLamports: 1000000000n, feeReserveLamports: 10000000n, maxPlanAgeMs: 60000 });
function selection(wallets) {
  requireSafe(Array.isArray(wallets) && wallets.length > 0 && wallets.length <= LIMITS.maxWallets, 'INVALID_WALLET_COUNT');
  const seen = new Set(), ids = new Set();
  for (const w of wallets) { requireSafe(w && typeof w.id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(w.id), 'INVALID_WALLET_ID'); validAddress(w.address); requireSafe(!seen.has(w.address) && !ids.has(w.id), 'DUPLICATE_WALLET'); seen.add(w.address); ids.add(w.id); }
}
function bounds(slippageBps, tipLamports) {
  requireSafe(Number.isSafeInteger(slippageBps) && slippageBps >= 1 && slippageBps <= LIMITS.maxSlippageBps, 'SLIPPAGE_OUT_OF_RANGE');
  requireSafe(raw(tipLamports, { positive: false }) <= LIMITS.maxTipLamports, 'TIP_LIMIT_EXCEEDED');
  requireSafe(tipLamports === '0', 'JITO_TIPPING_DISABLED');
}
function envelope(body, now) {
  requireSafe(Number.isSafeInteger(now) && now > 0, 'INVALID_CLOCK');
  const plan = { version: 1, id: randomUUID(), cluster: 'devnet', createdAt: now, expiresAt: now + LIMITS.maxPlanAgeMs, ...body };
  return frozenJson({ plan, digest: digest(plan) });
}
export function sellPlan({ mint, wallets, percent, slippageBps = 100, tipLamports = '0', route = 'bonding-curve', now = Date.now() }) {
  validAddress(mint); selection(wallets); bounds(slippageBps, tipLamports);
  requireSafe(route === 'bonding-curve', 'UNVERIFIED_ROUTE_DISABLED');
  const bps = percentage(percent);
  let total = 0n;
  const rows = wallets.map(w => {
    exactKeys(w, ['id', 'address', 'balanceRaw', 'quotedOutputLamports']);
    requireSafe(typeof w.id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(w.id), 'INVALID_WALLET_ID');
    const amount = raw(w.balanceRaw) * bps / 10000n;
    requireSafe(amount > 0n, 'SALE_ROUNDS_TO_ZERO');
    // Quote must be for this computed sale amount, from the trusted route adapter.
    const quote = raw(w.quotedOutputLamports);
    const minimum = quote * BigInt(10000 - slippageBps) / 10000n;
    requireSafe(minimum > 0n, 'MINIMUM_PROCEEDS_ZERO'); total += amount;
    return { id: w.id, address: w.address, balanceRaw: w.balanceRaw, amountRaw: String(amount), quotedOutputLamports: String(quote), minimumOutputLamports: String(minimum) };
  });
  return envelope({ action: 'sell', mint, route, mode: 'independent-wallets', percentageBps: String(bps), slippageBps, tipLamports, totalAmountRaw: String(total), wallets: rows, proceeds: 'original-wallets', quoteStatus: 'external-unverified', broadcast: false }, now);
}
export function fundingPlan({ payerAddress, wallets, tipLamports = '0', now = Date.now() }) {
  validAddress(payerAddress); selection(wallets); bounds(100, tipLamports);
  let total = raw(tipLamports, { positive: false });
  const rows = wallets.map(w => { exactKeys(w, ['id', 'address', 'lamports']); requireSafe(w.address !== payerAddress, 'SELF_TRANSFER'); const n = raw(w.lamports); requireSafe(n <= LIMITS.maxSpendLamports, 'SPEND_LIMIT_EXCEEDED'); total += n; return { ...w }; });
  requireSafe(total <= LIMITS.maxSpendLamports, 'TOTAL_SPEND_LIMIT_EXCEEDED');
  return envelope({ action: 'fund', payerAddress, wallets: rows, tipLamports, totalSpendLamports: String(total), feeReserveLamports: String(LIMITS.feeReserveLamports), broadcast: false }, now);
}
export function validateEnvelope(envelope, confirmation, now = Date.now()) {
  exactKeys(envelope, ['plan', 'digest']);
  const p = envelope.plan;
  requireSafe(equalDigest(envelope.digest, digest(p)) && equalDigest(confirmation, envelope.digest), 'PLAN_CHANGED_OR_UNAPPROVED');
  requireSafe(p.version === 1 && p.cluster === 'devnet' && p.broadcast === false, 'PLAN_POLICY_MISMATCH');
  requireSafe(Number.isSafeInteger(now) && p.createdAt <= now && now < p.expiresAt && p.expiresAt - p.createdAt === LIMITS.maxPlanAgeMs, 'PLAN_EXPIRED_OR_INVALID');
  // Re-run the full amount/recipient schema rather than trusting a self-supplied hash.
  let rebuilt;
  if (p.action === 'fund') rebuilt = fundingPlan({ payerAddress: p.payerAddress, wallets: p.wallets, tipLamports: p.tipLamports, now: p.createdAt }).plan;
  else if (p.action === 'sell') rebuilt = sellPlan({ mint: p.mint, wallets: p.wallets.map(w => ({ id: w.id, address: w.address, balanceRaw: w.balanceRaw, quotedOutputLamports: w.quotedOutputLamports })), percent: `${BigInt(p.percentageBps) / 100n}.${String(BigInt(p.percentageBps) % 100n).padStart(2, '0')}`, slippageBps: p.slippageBps, tipLamports: p.tipLamports, route: p.route, now: p.createdAt }).plan;
  else requireSafe(false, 'UNKNOWN_PLAN_ACTION');
  rebuilt = { ...rebuilt, id: p.id };
  requireSafe(digest(rebuilt) === digest(p), 'PLAN_SCHEMA_MISMATCH');
  return frozenJson(p);
}
