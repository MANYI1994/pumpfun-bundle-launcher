export function attachLauncherPanel({ api, connectedAddress }) {
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
  field('buy-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('buy-review'), 'buy-result', '/api/buy-review', {
      owner: connectedAddress() || '', mint: value('monitor-mint'),
      spendLamports: value('buy-budget'), slippageBps: Number(value('buy-slippage')),
    });
  });
  field('sell-form').addEventListener('submit', event => {
    event.preventDefault();
    action(field('sell-review'), 'sell-result', '/api/sell-review', {
      ...target(), percent: value('sell-percent'), slippageBps: Number(value('sell-slippage')),
      quotedOutputLamports: value('sell-quote'),
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
