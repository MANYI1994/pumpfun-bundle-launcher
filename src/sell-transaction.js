import { compileSolTradeCandidate } from './buy-transaction.js';
import { Rpc } from './network.js';
import { digest, frozenJson } from './security.js';
import { reviewSell } from './sell-review.js';

export async function compileSellCandidate(input, rpc = new Rpc()) {
  const { review } = await reviewSell(input, rpc);
  return compileSolTradeCandidate(review, rpc);
}

export async function buildSellTransaction(input, rpc = new Rpc()) {
  const { candidate } = await compileSellCandidate(input, rpc);
  return frozenJson({ review: candidate, digest: digest(candidate) });
}
