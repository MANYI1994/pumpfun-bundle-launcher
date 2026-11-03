import { verifyCreationSignatures } from './create-verification.js';
import { reviewPumpSwap } from './pumpswap-review.js';
import { detectMigration } from './migration.js';
import { buildSellTransaction } from './sell-transaction.js';
import { buildBuyTransaction } from './buy-transaction.js';
import { reviewBuy } from './buy-review.js';
import { balances } from './wallet-balances.js';
import { reviewSell } from './sell-review.js';
import { Rpc, assertDevnetContext } from './network.js';
import { exactKeys, requireSafe, validAddress, shortError } from './security.js';
import { tokenMetadata, reviewTokenCreation } from './create-token.js';

export const PANEL_ROUTES = Object.freeze(['/api/metadata', '/api/create-review', '/api/create-verify', '/api/balances', '/api/watch-balances', '/api/migration', '/api/pumpswap-review', '/api/sell-review', '/api/sell-transaction', '/api/buy-review', '/api/buy-transaction']);

export async function launcherPanel(route, input) {
  if (route === '/api/sell-transaction') return buildSellTransaction(input);
  if (route === '/api/buy-transaction') return buildBuyTransaction(input);
  if (route === '/api/buy-review') return reviewBuy(input);
  if (route === '/api/pumpswap-review') return reviewPumpSwap(input);
  if (route === '/api/migration') return detectMigration(input);
  if (route === '/api/metadata') return tokenMetadata(input);
  const rpc = new Rpc();
  if (route === '/api/create-review') {
    const context = await rpc.getBlockhashContext();
    const result = await reviewTokenCreation(input, assertDevnetContext(context));
    assertDevnetContext(context);
    return { ...result, expiresAt: context.expiresAt };
  }
  if (route === '/api/create-verify') {
    exactKeys(input, ['envelope', 'confirmation', 'signedWires']);
    const verified = await verifyCreationSignatures(input.envelope, input.confirmation, input.signedWires);
    const validity = await rpc.read('isBlockhashValid', [input.envelope.review.blockhash, { commitment: 'confirmed' }]);
    requireSafe(validity?.value === true, 'CREATION_BLOCKHASH_EXPIRED');
    const { signedWireBase64, ...receipt } = verified;
    return receipt;
  }
  if (route === '/api/watch-balances') {
    exactKeys(input, ['wallets', 'mint']);
    requireSafe(Array.isArray(input.wallets) && input.wallets.length > 0 &&
      input.wallets.length <= 6, 'INVALID_WALLET_COUNT');
    const seen = new Set();
    const wallets = input.wallets.map(wallet => {
      exactKeys(wallet, ['label', 'address']);
      requireSafe(typeof wallet.label === 'string' && /^[a-zA-Z0-9 _-]{1,32}$/.test(wallet.label),
        'INVALID_WALLET_LABEL');
      const address = validAddress(wallet.address);
      requireSafe(!seen.has(address), 'DUPLICATE_WALLET');
      seen.add(address);
      return { label: wallet.label, address };
    });
    if (input.mint !== '') validAddress(input.mint);
    return Promise.all(wallets.map(async wallet => {
      try { return { ...wallet, balance: await balances(rpc, wallet.address, input.mint) }; }
      catch (error) { return { ...wallet, error: shortError(error) }; }
    }));
  }
  if (route === '/api/balances') {
    exactKeys(input, ['owner', 'mint']);
    return balances(rpc, input.owner, input.mint);
  }
  requireSafe(route === '/api/sell-review', 'UNKNOWN_PANEL_ROUTE');
  return reviewSell(input, rpc);
}
