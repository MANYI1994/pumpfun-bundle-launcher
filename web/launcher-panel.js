export function attachLauncherPanel({ api, connectedAddress, sign, showExecution }) {
  const field = id => document.getElementById(id);
  const value = id => field(id).value.trim();
  const metadata = () => ({
    name: value('token-name'), symbol: value('token-symbol'),
    description: value('token-description'), image: value('token-image'),
  });
  const target = () => ({ owner: value('monitor-owner') || connectedAddress() || '', mint: value('monitor-mint') });
  const display = (id, data) => { field(id).textContent = JSON.stringify(data, null, 2); };
  async function action(button, output, route, input) {
    button.disabled = true;
    field(output).textContent = 'Loading…';
    try { display(output, await api(route, input)); }
    catch (error) { field(output).textContent = error.message; }
    finally { button.disabled = false; }
  }
  field('metadata-build').addEventListener('click', event => {
    action(event.currentTarget, 'creation-result', '/api/metadata', metadata());
  });
  field('creation-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('creation-review'), 'creation-result', '/api/create-review', {
      metadata: metadata(), metadataUri: value('token-uri'), mintAddress: value('token-mint'),
      creatorAddress: connectedAddress() || '',
    });
  });
  const buyInput = () => ({
    owner: connectedAddress() || '', mint: value('monitor-mint'),
    spendLamports: value('buy-budget'), slippageBps: Number(value('buy-slippage')),
  });
  field('buy-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('buy-review'), 'buy-result', '/api/buy-review', buyInput());
  });
  field('buy-transaction').addEventListener('click', () => {
    if (!field('buy-form').reportValidity()) return;
    action(field('buy-transaction'), 'buy-result', '/api/buy-transaction', buyInput());
  });
  let buyApproval = null;
  function clearBuyApproval() {
    buyApproval = null;
    field('buy-sign-simulate').disabled = true;
  }
  for (const id of ['monitor-mint', 'buy-budget', 'buy-slippage', 'buy-max-debit']) {
    field(id).addEventListener('input', clearBuyApproval);
  }
  field('buy-review').addEventListener('click', clearBuyApproval);
  field('buy-transaction').addEventListener('click', clearBuyApproval);
  field('buy-prepare-sign').addEventListener('click', async event => {
    clearBuyApproval();
    const button = event.currentTarget;
    const input = { ...buyInput(), maxDebitLamports: value('buy-max-debit') };
    button.disabled = true;
    field('buy-result').textContent = 'Preparing wallet approval…';
    try {
      const payload = await api('/api/buy-signing-review', input);
      const latest = { ...buyInput(), maxDebitLamports: value('buy-max-debit') };
      if (JSON.stringify(input) !== JSON.stringify(latest)) throw new Error('BUY_INPUT_CHANGED');
      buyApproval = payload;
      const { plan, budget, expiresAt } = payload.review.details;
      display('buy-result', {
        wallet: plan.owner, mint: plan.mint, destination: plan.destinationTokenAccount,
        tradeBudgetLamports: plan.tradeBudgetLamports, quotedNetworkFeeLamports: budget.feeLamports,
        maxTotalDebitLamports: plan.maxDebitLamports, minimumTokenAmountRaw: plan.minimumTokenAmountRaw,
        expiresAt: new Date(expiresAt).toISOString(), digest: payload.review.digest,
      });
      field('buy-sign-simulate').disabled = false;
    } catch (error) { field('buy-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
  field('buy-sign-simulate').addEventListener('click', async () => {
    const payload = buyApproval;
    clearBuyApproval();
    if (!payload) return;
    field('buy-result').textContent = 'Awaiting wallet signature and devnet simulation…';
    try {
      const signedTransactions = await sign(payload, payload.review.digest);
      const result = await api('/api/verify', { reviewDigest: payload.review.digest, signedTransactions });
      display('buy-result', result);
      showExecution(result, payload.review.details.plan);
    } catch (error) { field('buy-result').textContent = error.message; }
  });
  field('sell-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('sell-review'), 'sell-result', '/api/sell-review', {
      owner: connectedAddress() || '', mint: value('monitor-mint'),
      percent: value('sell-percent'), slippageBps: Number(value('sell-slippage')),
    });
  });
  let timer;
  let revision = 0;
  let inFlight = false;
  async function refresh() {
    if (document.hidden || inFlight) return;
    inFlight = true;
    const current = revision;
    const requested = target();
    try {
      const balances = await api('/api/balances', requested);
      const latest = target();
      if (current === revision && latest.owner === requested.owner && latest.mint === requested.mint) {
        display('balance-result', balances);
      }
    } catch (error) {
      if (current === revision) field('balance-result').textContent = error.message;
    } finally { inFlight = false; }
  }
  field('monitor-start').addEventListener('click', () => {
    clearInterval(timer);
    revision++;
    field('balance-result').textContent = 'Waiting for balance…';
    timer = setInterval(refresh, 15000);
    refresh();
  });
  field('monitor-stop').addEventListener('click', () => {
    clearInterval(timer);
    revision++;
    field('balance-result').textContent = 'Monitoring stopped.';
  });
}
