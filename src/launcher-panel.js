import { buildBuyTransaction } from './buy-transaction.js';
import { reviewBuy } from './buy-review.js';
import { balances } from './wallet-balances.js';
import { reviewSell } from './sell-review.js';
import { Rpc, assertDevnetContext } from './network.js';
import { exactKeys, requireSafe } from './security.js';
import { tokenMetadata, reviewTokenCreation } from './create-token.js';

export const PANEL_ROUTES = Object.freeze(['/api/metadata', '/api/create-review', '/api/balances', '/api/sell-review', '/api/buy-review', '/api/buy-transaction']);

export async function launcherPanel(route, input) {
  if (route === '/api/buy-transaction') return buildBuyTransaction(input);
  if (route === '/api/buy-review') return reviewBuy(input);
  if (route === '/api/metadata') return tokenMetadata(input);
  const rpc = new Rpc();
  if (route === '/api/create-review') {
    const context = await rpc.getBlockhashContext();
    const result = await reviewTokenCreation(input, assertDevnetContext(context));
    assertDevnetContext(context);
    return result;
  }
  if (route === '/api/balances') {
    exactKeys(input, ['owner', 'mint']);
    return balances(rpc, input.owner, input.mint);
  }
  requireSafe(route === '/api/sell-review', 'UNKNOWN_PANEL_ROUTE');
  return reviewSell(input, rpc);
}
