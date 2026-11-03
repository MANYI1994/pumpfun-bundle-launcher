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
  const sellInput = () => ({
    owner: connectedAddress() || '', mint: value('monitor-mint'),
    percent: value('sell-percent'), slippageBps: Number(value('sell-slippage')),
  });
  field('sell-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('sell-review'), 'sell-result', '/api/sell-review', sellInput());
  });
  field('sell-transaction').addEventListener('click', () => {
    if (!field('sell-form').reportValidity()) return;
    action(field('sell-transaction'), 'sell-result', '/api/sell-transaction', sellInput());
  });
  let tradeApproval;
  let approvalRevision = 0;
  function clearTradeApproval() {
    tradeApproval = null;
    approvalRevision++;
    for (const actionName of ['buy', 'sell']) field(actionName + '-sign-simulate').disabled = true;
  }
  for (const id of ['monitor-mint', 'buy-budget', 'buy-slippage', 'buy-max-debit', 'sell-percent', 'sell-slippage']) {
    field(id).addEventListener('input', clearTradeApproval);
  }

  function bindTradeApproval(actionName, readInput) {
    const output = actionName + '-result';
    const signButton = field(actionName + '-sign-simulate');
    field(actionName + '-form').addEventListener('submit', clearTradeApproval);
    field(actionName + '-transaction').addEventListener('click', clearTradeApproval);
    field(actionName + '-prepare-sign').addEventListener('click', async event => {
      if (!field(actionName + '-form').reportValidity()) return;
      clearTradeApproval();
      const current = approvalRevision;
      const button = event.currentTarget;
      const input = readInput();
      button.disabled = true;
      field(output).textContent = 'Preparing wallet approval…';
      try {
        const payload = await api('/api/' + actionName + '-signing-review', input);
        if (current !== approvalRevision || JSON.stringify(input) !== JSON.stringify(readInput())) {
          throw new Error('TRADE_INPUT_CHANGED');
        }
        tradeApproval = payload;
        const { plan, budget, expiresAt } = payload.review.details;
        const amounts = actionName === 'buy'
          ? { tradeBudgetLamports: plan.tradeBudgetLamports, maxTotalDebitLamports: plan.maxDebitLamports,
              minimumTokenAmountRaw: plan.minimumTokenAmountRaw, destination: plan.destinationTokenAccount }
          : { amountRaw: plan.amountRaw, minimumOutputLamports: plan.minimumOutputLamports,
              sourceTokenAccount: plan.sourceTokenAccount, proceedsAddress: plan.proceedsAddress };
        display(output, { wallet: plan.owner, mint: plan.mint, ...amounts,
          quotedNetworkFeeLamports: budget.feeLamports, expiresAt: new Date(expiresAt).toISOString(),
          digest: payload.review.digest });
        signButton.disabled = false;
      } catch (error) { field(output).textContent = error.message; }
      finally { button.disabled = false; }
    });
    signButton.addEventListener('click', async () => {
      const payload = tradeApproval;
      if (payload?.review.details.plan.action !== actionName) return;
      clearTradeApproval();
      field(output).textContent = 'Awaiting wallet signature and devnet simulation…';
      try {
        const signedTransactions = await sign(payload, payload.review.digest);
        const result = await api('/api/verify', { reviewDigest: payload.review.digest, signedTransactions });
        display(output, result);
        showExecution(result, payload.review.details.plan);
      } catch (error) { field(output).textContent = error.message; }
    });
  }
  bindTradeApproval('buy', () => ({ ...buyInput(), maxDebitLamports: value('buy-max-debit') }));
  bindTradeApproval('sell', sellInput);

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
