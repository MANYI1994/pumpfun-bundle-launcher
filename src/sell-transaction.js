import { compileSolTradeCandidate } from './buy-transaction.js';
import { Rpc } from './network.js';
import { digest, frozenJson } from './security.js';
import { reviewSell } from './sell-review.js';

export async function buildSellTransaction(input, rpc = new Rpc()) {
  const { review } = await reviewSell(input, rpc);
  const { candidate } = await compileSolTradeCandidate(review, rpc);
  return frozenJson({ review: candidate, digest: digest(candidate) });
}
